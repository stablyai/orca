/* eslint-disable max-lines -- Why: SSH connection lifecycle, credential retries, reconnect policy, and transport fallback are intentionally co-located so state transitions stay auditable in one file. */
import * as net from 'net'
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
  private connectGeneration = 0

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

  // Why: exposes whether a passphrase/password is already cached in-memory for
  // this connection. Used by ssh:needsPassphrasePrompt so callers can decide
  // whether a manual-reconnect will prompt or go through silently. Without this,
  // lastRequiredPassphrase stays true across the session even after the user
  // has entered the credential once, causing redundant "enter passphrase"
  // prompts on disconnect→reconnect cycles within a single app session.
  hasCachedCredential(): boolean {
    return this.cachedPassphrase != null || this.cachedPassword != null
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
    const connectGeneration = ++this.connectGeneration

    const resolved = await resolveWithSshG(this.target.configHost || this.target.label).catch(
      () => null
    )
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
      await this.doSsh2Connect(config, connectGeneration)
    } catch (err) {
      if (!(err instanceof Error) || !this.callbacks.onCredentialRequest) {
        this.proxyProcess?.kill()
        this.proxyProcess = null
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
          await this.doSsh2Connect(config, connectGeneration)
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
          await this.doSsh2Connect(config, connectGeneration)
          return
        }
      }
      this.proxyProcess?.kill()
      this.proxyProcess = null
      throw err
    }
  }

  // Why: ssh2 may destroy the proxy socket on auth failure, so credential
  // retries need a fresh proxy process and Duplex stream.
  private respawnProxy(
    config: ConnectConfig,
    proxy: ReturnType<typeof resolveEffectiveProxy> | null | undefined
  ): void {
    if (!proxy) {
      return
    }
    this.proxyProcess?.kill()
    const p = spawnProxyCommand(proxy, config.host!, config.port!, config.username!)
    this.proxyProcess = p.process
    config.sock = p.sock
  }

  private doSsh2Connect(config: ConnectConfig, connectGeneration: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const client = new SshClient()
      let settled = false
      client.on('ready', () => {
        if (settled) {
          return
        }
        // Why: connect() completion races with explicit disconnect(). Once a
        // newer connect attempt or disconnect bumps the generation/disposed
        // state, this late ready event must not resurrect the torn-down client.
        if (this.disposed || connectGeneration !== this.connectGeneration) {
          settled = true
          client.end()
          client.destroy()
          reject(new Error('SSH connection attempt was cancelled'))
          return
        }
        settled = true
        this.client = client
        this.proxyProcess = null
        // Why: ssh2 leaves Nagle's algorithm on by default. For single-byte
        // keystrokes through a remote PTY this stacks with the kernel's
        // delayed-ACK timer and adds up to ~40 ms per keystroke. OpenSSH's
        // `ssh` sets TCP_NODELAY whenever a PTY is allocated; we mirror that
        // because every channel we open over this connection (PTY data,
        // JSON-RPC requests, port-scan probes) is latency-sensitive. No-op
        // for proxy-command / proxy-jump connections where _sock is a custom
        // Duplex; that case relies on the proxy program's own TCP behavior,
        // same as native ssh.
        const sock = (client as unknown as { _sock?: { setNoDelay?: unknown } })._sock
        if (sock instanceof net.Socket) {
          console.warn(`[ssh] TCP_NODELAY enabled for ${this.target.label}`)
        } else {
          console.warn(`[ssh] TCP_NODELAY skipped for ${this.target.label} (proxy socket)`)
        }
        client.setNoDelay(true)
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
        // Why: reset reconnectAttempt before attemptConnect so setState('connected')
        // broadcasts reconnectAttempt=0, which ssh.ts uses to trigger relay re-establishment.
        this.state.reconnectAttempt = 0
        await this.attemptConnect()
      } catch (err) {
        if (this.disposed) {
          return
        }
        const error = err instanceof Error ? err : new Error(String(err))
        if (isAuthError(error) || isPassphraseError(error)) {
          this.setState('auth-failed', error.message)
          return
        }
        if (!isTransientError(error)) {
          this.setState('error', error.message)
          return
        }
        this.state.reconnectAttempt = attempt + 1
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
          reject(
            new Error(
              code !== 0
                ? `System SSH exited with code ${code}`
                : 'System SSH exited before producing output'
            )
          )
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
    this.connectGeneration += 1
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
    }
    this.reconnectTimer = null
    this.cachedPassphrase = null
    this.cachedPassword = null
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
