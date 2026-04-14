import { Client as SshClient } from 'ssh2'
import type { ClientChannel, SFTPWrapper } from 'ssh2'
import type { SshTarget, SshConnectionState, SshConnectionStatus } from '../../shared/ssh-types'
import { spawnSystemSsh, type SystemSshProcess } from './ssh-system-fallback'
import { resolveWithSshG } from './ssh-config-parser'
import {
  INITIAL_RETRY_ATTEMPTS,
  INITIAL_RETRY_DELAY_MS,
  RECONNECT_BACKOFF_MS,
  CONNECT_TIMEOUT_MS,
  isTransientError,
  sleep,
  buildConnectConfig,
  type SshConnectionCallbacks
} from './ssh-connection-utils'
export type { SshConnectionCallbacks } from './ssh-connection-utils'

export class SshConnection {
  private client: SshClient | null = null
  private systemSsh: SystemSshProcess | null = null
  private state: SshConnectionState
  private callbacks: SshConnectionCallbacks
  private target: SshTarget
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

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
    const client = this.client
    if (!client) {
      throw new Error('Not connected')
    }
    return new Promise((resolve, reject) => {
      client.exec(command, (err, channel) => {
        if (err) {
          reject(err)
        } else {
          resolve(channel)
        }
      })
    })
  }

  async sftp(): Promise<SFTPWrapper> {
    const client = this.client
    if (!client) {
      throw new Error('Not connected')
    }
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(err)
        } else {
          resolve(sftp)
        }
      })
    })
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

        if (!isTransientError(lastError)) {
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

  // Why: matches VS Code's _connectSSH (lines 720-774). Config is built before
  // connecting, ssh2's readyTimeout handles the timeout, and no custom
  // authHandler or hostVerifier is set — ssh2 handles auth natively.
  private async attemptConnect(): Promise<void> {
    this.setState('connecting')

    const resolved = await resolveWithSshG(this.target.label).catch(() => null)
    const config = buildConnectConfig(this.target, resolved)

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
        this.setState('error', err.message)
        reject(err)
      })

      client.connect(config)
    })
  }

  // Why: both `end` and `close` fire on disconnect. If reconnect succeeds
  // between the two events, the second handler would null out the *new*
  // connection. Guarding on `this.client === client` prevents that.
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
        this.setState('connected')
      } catch {
        this.state.reconnectAttempt++
        this.scheduleReconnect()
      }
    }, delay)
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

      proc.onExit((_code) => {
        if (!this.disposed && this.systemSsh === proc) {
          this.systemSsh = null
          this.scheduleReconnect()
        }
      })

      return proc
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.setState('error', msg)
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
    this.systemSsh?.kill()
    this.systemSsh = null
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
