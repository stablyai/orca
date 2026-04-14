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
  private cachedPassword: string | null = null

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

  async exec(cmd: string): Promise<ClientChannel> {
    if (!this.client) {
      throw new Error('Not connected')
    }
    return new Promise((res, rej) => this.client!.exec(cmd, (e, ch) => (e ? rej(e) : res(ch))))
  }

  async sftp(): Promise<SFTPWrapper> {
    if (!this.client) {
      throw new Error('Not connected')
    }
    return new Promise((res, rej) => this.client!.sftp((e, s) => (e ? rej(e) : res(s))))
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
    if (this.cachedPassword) {
      config.password = this.cachedPassword
    }

    try {
      await this.doSsh2Connect(config)
    } catch (err) {
      if (!(err instanceof Error) || !this.callbacks.onCredentialRequest) {
        throw err
      }
      // Why: prompt for passphrase on encrypted-key error, then retry with
      // a fresh proxy socket (ssh2 may have destroyed the original).
      if (isPassphraseError(err) && !this.cachedPassphrase) {
        const detail = this.target.identityFile || resolved?.identityFile?.[0] || '(unknown)'
        const val = await this.callbacks.onCredentialRequest(this.target.id, 'passphrase', detail)
        if (val) {
          this.cachedPassphrase = val
          config.passphrase = val
          this.respawnProxy(config, effectiveProxy)
          await this.doSsh2Connect(config)
          return
        }
      }
      // Why: prompt for password on auth failure. Check the original error
      // (not a retry error) to avoid conflating passphrase vs password failures.
      if (isAuthError(err) && !this.cachedPassword) {
        const val = await this.callbacks.onCredentialRequest(
          this.target.id,
          'password',
          config.host || this.target.label
        )
        if (val) {
          this.cachedPassword = val
          config.password = val
          this.respawnProxy(config, effectiveProxy)
          await this.doSsh2Connect(config)
          return
        }
      }
      throw err
    }
  }

  // Why: ssh2 may destroy the proxy socket on auth failure, so credential
  // retries need a fresh proxy process and Duplex stream.
  private respawnProxy(config: ConnectConfig, proxy: string | null | undefined): void {
    if (!proxy) {
      return
    }
    this.proxyProcess?.kill()
    const p = spawnProxyCommand(proxy, config.host!, config.port!, config.username!)
    this.proxyProcess = p.process
    config.sock = p.sock
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

  // Why: guard on identity so a late event from the old client doesn't
  // null out a successful reconnect.
  private setupDisconnectHandler(client: SshClient): void {
    const onDrop = () => {
      if (this.disposed || this.client !== client) {
        return
      }
      this.client = null
      this.scheduleReconnect()
    }
    client.on('end', onDrop)
    client.on('close', onDrop)
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
    }, RECONNECT_BACKOFF_MS[attempt])
  }

  async connectViaSystemSsh(): Promise<SystemSshProcess> {
    if (this.disposed) {
      throw new Error('Connection disposed')
    }
    this.systemSsh?.kill()
    this.systemSsh = null
    this.setState('connecting')
    try {
      const proc = spawnSystemSsh(this.target)
      this.systemSsh = proc
      let settled = false
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          settled = true
          proc.kill()
          reject(new Error('System SSH connection timed out'))
        }, CONNECT_TIMEOUT_MS)
        proc.stdout.once('data', () => {
          settled = true
          clearTimeout(timeout)
          resolve()
        })
        proc.onExit((code) => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timeout)
          if (code !== 0) {
            reject(new Error(`System SSH exited with code ${code}`))
          }
        })
      })
      this.setState('connected')
      // Why: register reconnection handler only after the initial handshake
      // succeeds. The onExit registered above guards with `settled` so it
      // won't fire a duplicate for exits during the handshake phase.
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
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    this.reconnectTimer = null
    this.client?.end()
    this.client = null
    this.proxyProcess?.kill()
    this.proxyProcess = null
    this.systemSsh?.kill()
    this.systemSsh = null
    this.setState('disconnected')
  }

  private setState(status: SshConnectionStatus, error?: string): void {
    this.state = { ...this.state, status, error: error ?? null }
    this.callbacks.onStateChange(this.target.id, { ...this.state })
  }
}

export { SshConnectionManager } from './ssh-connection-manager'
