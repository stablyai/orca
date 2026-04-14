import { Client as SshClient } from 'ssh2'
import type { ChildProcess } from 'child_process'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import type { SshTarget, SshConnectionState, SshConnectionStatus } from '../../shared/ssh-types'
import { spawnSystemSsh, type SystemSshProcess } from './ssh-system-fallback'
import { resolveWithSshG } from './ssh-config-parser'
import {
  INITIAL_RETRY_ATTEMPTS,
  INITIAL_RETRY_DELAY_MS,
  RECONNECT_BACKOFF_MS,
  CONNECT_TIMEOUT_MS,
  isTransientError,
  isAuthError,
  isPassphraseError,
  sleep,
  buildConnectConfig,
  resolveEffectiveProxy,
  spawnProxyCommand,
  type SshConnectionCallbacks
} from './ssh-connection-utils'
export type { SshConnectionCallbacks } from './ssh-connection-utils'

export class SshConnection {
  private client: SshClient | null = null
  private proxyProcess: ChildProcess | null = null
  private systemSsh: SystemSshProcess | null = null
  private state: SshConnectionState
  private callbacks: SshConnectionCallbacks
  private target: SshTarget
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private cachedPassphrase: string | null = null

  constructor(target: SshTarget, callbacks: SshConnectionCallbacks) {
    this.target = target
    this.callbacks = callbacks
    this.state = {
      targetId: target.id,
      status: 'disconnected',
      error: null,
      reconnectAttempt: 0
    }
  }

  getState(): SshConnectionState {
    return { ...this.state }
  }

  getClient(): SshClient | null {
    return this.client
  }

  getTarget(): SshTarget {
    return { ...this.target }
  }

  async exec(command: string): Promise<ClientChannel> {
    if (!this.client) {
      throw new Error('Not connected')
    }
    return new Promise((resolve, reject) =>
      this.client!.exec(command, (err, ch) => (err ? reject(err) : resolve(ch)))
    )
  }

  async sftp(): Promise<SFTPWrapper> {
    if (!this.client) {
      throw new Error('Not connected')
    }
    return new Promise((resolve, reject) =>
      this.client!.sftp((err, s) => (err ? reject(err) : resolve(s)))
    )
  }

  async connect(): Promise<void> {
    if (this.disposed) {
      throw new Error('Connection disposed')
    }

    let lastError: Error | null = null

    for (let attempt = 0; attempt < INITIAL_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.attemptConnect()
        return
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))

        if (isAuthError(lastError) || isPassphraseError(lastError)) {
          this.setState('auth-failed', lastError.message)
          throw lastError
        }

        if (!isTransientError(lastError)) {
          this.setState('error', lastError.message)
          throw lastError
        }

        if (attempt < INITIAL_RETRY_ATTEMPTS - 1) {
          await sleep(INITIAL_RETRY_DELAY_MS)
        }
      }
    }

    const finalError = lastError ?? new Error('Connection failed')
    this.setState('error', finalError.message)
    throw finalError
  }

  private async attemptConnect(): Promise<void> {
    this.setState('connecting')
    this.proxyProcess?.kill()
    this.proxyProcess = null

    const resolved = await resolveWithSshG(this.target.label).catch(() => null)
    const config = buildConnectConfig(this.target, resolved)

    // Why: ssh2 doesn't support ProxyCommand/ProxyJump natively. Spawn the
    // resolved proxy and pipe its stdin/stdout as config.sock.
    const effectiveProxy = resolveEffectiveProxy(this.target, resolved)
    if (effectiveProxy) {
      const proxy = spawnProxyCommand(effectiveProxy, config.host!, config.port!, config.username!)
      this.proxyProcess = proxy.process
      config.sock = proxy.sock
    }

    if (this.cachedPassphrase) {
      config.passphrase = this.cachedPassphrase
    }

    try {
      await this.doSsh2Connect(config)
    } catch (err) {
      // Why: ssh2 fails immediately when given an encrypted key without a
      // passphrase. Prompt the user and retry once with the passphrase.
      if (
        err instanceof Error &&
        isPassphraseError(err) &&
        !this.cachedPassphrase &&
        this.callbacks.onPassphraseRequest
      ) {
        const keyPath = this.target.identityFile || resolved?.identityFile?.[0] || '(unknown)'
        const passphrase = await this.callbacks.onPassphraseRequest(this.target.id, keyPath)
        if (passphrase) {
          this.cachedPassphrase = passphrase
          config.passphrase = passphrase
          await this.doSsh2Connect(config)
          return
        }
      }
      throw err
    }
  }

  private doSsh2Connect(config: ConnectConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const client = new SshClient()
      let settled = false
      client.on('ready', () => {
        if (settled) {
          return
        }
        settled = true
        this.client = client
        this.setState('connected')
        this.setupDisconnectHandler(client)
        resolve()
      })
      client.on('error', (err) => {
        if (settled) {
          return
        }
        settled = true
        client.destroy()
        reject(err)
      })
      client.connect(config)
    })
  }

  // Why: both `end` and `close` fire on disconnect. Guard on identity so
  // a late event from the old client doesn't null out a successful reconnect.
  private setupDisconnectHandler(client: SshClient): void {
    const handleDisconnect = () => {
      if (this.disposed || this.client !== client) {
        return
      }
      this.client = null
      this.scheduleReconnect()
    }
    client.on('end', handleDisconnect)
    client.on('close', handleDisconnect)
    client.on('error', (err) => {
      if (this.disposed || this.client !== client) {
        return
      }
      console.warn(`[ssh] Connection error for ${this.target.label}: ${err.message}`)
      this.client = null
      this.scheduleReconnect()
    })
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) {
      return
    }

    const attempt = this.state.reconnectAttempt
    if (attempt >= RECONNECT_BACKOFF_MS.length) {
      this.setState('reconnection-failed', 'Max reconnection attempts reached')
      return
    }

    this.setState('reconnecting')
    const delay = RECONNECT_BACKOFF_MS[attempt]

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.disposed) {
        return
      }

      try {
        await this.attemptConnect()
        this.state.reconnectAttempt = 0
      } catch {
        this.state.reconnectAttempt++
        this.scheduleReconnect()
      }
    }, delay)
  }

  async connectViaSystemSsh(): Promise<SystemSshProcess> {
    if (this.disposed) { throw new Error('Connection disposed') }
    this.systemSsh?.kill()
    this.systemSsh = null
    this.setState('connecting')
    try {
      const proc = spawnSystemSsh(this.target)
      this.systemSsh = proc
      let settled = false
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          settled = true; proc.kill()
          reject(new Error('System SSH connection timed out'))
        }, CONNECT_TIMEOUT_MS)
        proc.stdout.once('data', () => { settled = true; clearTimeout(timeout); resolve() })
        proc.onExit((code) => {
          if (settled) { return }
          settled = true; clearTimeout(timeout)
          if (code !== 0) { reject(new Error(`System SSH exited with code ${code}`)) }
        })
      })
      this.setState('connected')
      proc.onExit(() => {
        if (!this.disposed && this.systemSsh === proc) {
          this.systemSsh = null
          this.scheduleReconnect()
        }
      })
      return proc
    } catch (err) {
      this.setState('error', err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  async disconnect(): Promise<void> {
    this.disposed = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer) }
    this.reconnectTimer = null
    this.client?.end(); this.client = null
    this.proxyProcess?.kill(); this.proxyProcess = null
    this.systemSsh?.kill(); this.systemSsh = null
    this.setState('disconnected')
  }

  private setState(status: SshConnectionStatus, error?: string): void {
    this.state = {
      ...this.state,
      status,
      error: error ?? null
    }
    this.callbacks.onStateChange(this.target.id, { ...this.state })
  }
}

export { SshConnectionManager } from './ssh-connection-manager'
