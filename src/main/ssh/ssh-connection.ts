import { Client as SshClient } from 'ssh2'
import type { ClientChannel, SFTPWrapper } from 'ssh2'
import { createHash } from 'crypto'
import type { SshTarget, SshConnectionState, SshConnectionStatus } from '../../shared/ssh-types'
import { spawnSystemSsh, type SystemSshProcess } from './ssh-system-fallback'
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
// Why: type definitions live in ssh-connection-utils.ts to break a circular
// import. Re-exported here so existing import sites keep working.
export type {
  HostKeyVerifyRequest,
  AuthChallengeRequest,
  SshConnectionCallbacks
} from './ssh-connection-utils'

export class SshConnection {
  private client: SshClient | null = null
  private systemSsh: SystemSshProcess | null = null
  private state: SshConnectionState
  private callbacks: SshConnectionCallbacks
  private target: SshTarget
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private agentAttempted = false
  private keyAttempted = false
  private hostKeyVerified = false

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

  /** Open an exec channel. Used by relay deployment to run commands on the remote. */
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

  /** Open an SFTP session for file transfers (relay deployment). */
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

    throw lastError ?? new Error('Connection failed')
  }

  private async attemptConnect(): Promise<void> {
    this.setState('connecting')
    this.agentAttempted = false
    this.keyAttempted = false
    this.hostKeyVerified = false

    const config = await this.buildConfig()

    return new Promise<void>((resolve, reject) => {
      const client = new SshClient()
      let settled = false

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true
          client.destroy()
          reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS}ms`))
        }
      }, CONNECT_TIMEOUT_MS)

      // Why: ssh2's hostVerifier is synchronous, but we need async UI confirmation.
      // We intercept 'handshake' to prompt the user and only proceed if accepted.
      client.on('handshake', (negotiated) => {
        if (this.hostKeyVerified || settled) {
          return
        }

        const serverHostKey = (negotiated as unknown as Record<string, unknown>).serverHostKey
        if (!serverHostKey) {
          return
        }

        this.hostKeyVerified = true

        const keyType = typeof serverHostKey === 'string' ? serverHostKey : 'unknown'
        const fingerprint = createHash('sha256')
          .update(Buffer.from(keyType, 'utf-8'))
          .digest('base64')

        this.setState('host-key-verification')
        this.callbacks
          .onHostKeyVerify({
            host: this.target.host,
            ip: this.target.host,
            fingerprint,
            keyType
          })
          .then((accepted) => {
            if (!accepted && !settled) {
              settled = true
              clearTimeout(timeout)
              client.destroy()
              reject(new Error('Host key verification rejected by user'))
            }
          })
          .catch(() => {
            // If callback fails, allow connection to proceed
          })
      })

      client.on('ready', () => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
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
        clearTimeout(timeout)
        this.setState('error', err.message)
        reject(err)
      })

      client.connect(config)
    })
  }

  private async buildConfig() {
    // Why: config-building logic extracted to ssh-connection-utils.ts (max-lines).
    return buildConnectConfig(this.target, this.callbacks, {
      agentAttempted: this.agentAttempted,
      keyAttempted: this.keyAttempted,
      setState: (status: string, error?: string) => {
        this.setState(status as SshConnectionStatus, error)
      }
    })
  }

  private setupDisconnectHandler(client: SshClient): void {
    client.on('end', () => {
      if (this.disposed) {
        return
      }
      this.client = null
      this.scheduleReconnect()
    })

    client.on('close', () => {
      if (this.disposed) {
        return
      }
      this.client = null
      this.scheduleReconnect()
    })

    client.on('error', (err) => {
      if (this.disposed) {
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

  /** Fall back to system SSH binary when ssh2 cannot handle auth (FIDO2, ControlMaster). */
  async connectViaSystemSsh(): Promise<SystemSshProcess> {
    if (this.disposed) {
      throw new Error('Connection disposed')
    }
    this.setState('connecting')

    try {
      const proc = spawnSystemSsh(this.target)
      this.systemSsh = proc

      // Why: verify the SSH connection succeeded before reporting connected.
      // Wait for relay sentinel output or a non-zero exit.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('System SSH connection timed out'))
        }, CONNECT_TIMEOUT_MS)

        proc.stdout.once('data', () => {
          clearTimeout(timeout)
          resolve()
        })
        proc.onExit((code) => {
          clearTimeout(timeout)
          if (code !== 0) {
            reject(new Error(`System SSH exited with code ${code}`))
          }
        })
      })

      this.setState('connected')
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
      this.reconnectTimer = null
    }
    if (this.client) {
      this.client.end()
      this.client = null
    }
    if (this.systemSsh) {
      this.systemSsh.kill()
      this.systemSsh = null
    }
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

// Why: extracted to ssh-connection-manager.ts to stay under 300-line max-lines.
export { SshConnectionManager } from './ssh-connection-manager'
