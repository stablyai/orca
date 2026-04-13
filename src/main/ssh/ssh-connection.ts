import { Client as SshClient } from 'ssh2'
import type { ChildProcess } from 'child_process'
import type { ClientChannel, SFTPWrapper } from 'ssh2'
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
  /** Why: the jump host client must be tracked so it can be torn down on
   *  disconnect — otherwise the intermediate TCP connection leaks. */
  private jumpClient: SshClient | null = null
  private proxyProcess: ChildProcess | null = null
  private systemSsh: SystemSshProcess | null = null
  private state: SshConnectionState
  private callbacks: SshConnectionCallbacks
  private target: SshTarget
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private agentAttempted = false
  private keyAttempted = false

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

    const finalError = lastError ?? new Error('Connection failed')
    this.setState('error', finalError.message)
    throw finalError
  }

  private async attemptConnect(): Promise<void> {
    this.setState('connecting')
    this.agentAttempted = false
    this.keyAttempted = false

    // Why: clean up resources from a prior failed attempt before overwriting.
    // Without this, a retry after timeout/auth-failure orphans the old jump
    // host TCP connection and proxy child process.
    if (this.jumpClient) {
      this.jumpClient.end()
      this.jumpClient = null
    }
    if (this.proxyProcess) {
      this.proxyProcess.kill()
      this.proxyProcess = null
    }

    const { config, jumpClient, proxyProcess } = await this.buildConfig()
    this.jumpClient = jumpClient
    this.proxyProcess = proxyProcess

    return new Promise<void>((resolve, reject) => {
      const client = new SshClient()
      let settled = false

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true
          client.destroy()
          const msg = `Connection timed out after ${CONNECT_TIMEOUT_MS}ms`
          this.setState('error', msg)
          reject(new Error(msg))
        }
      }, CONNECT_TIMEOUT_MS)

      // Why: host key verification is now handled inside the hostVerifier
      // callback in buildConnectConfig (ssh-connection-utils.ts).  The
      // callback form `(key, verify) => void` blocks the handshake until
      // the user accepts/rejects, so no separate 'handshake' listener is
      // needed here.

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
        // Why: reset the counter and re-broadcast so the UI shows attempt 0.
        // attemptConnect already calls setState('connected'), but the attempt
        // counter must be zeroed *before* so the broadcast carries the right value.
        this.state.reconnectAttempt = 0
        this.setState('connected')
      } catch {
        // Why: increment before scheduleReconnect so the setState('reconnecting')
        // call inside it broadcasts the updated attempt number to the UI.
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
    // Why: if connectViaSystemSsh is called again after a prior failed attempt,
    // the old process may still be running. Without cleanup, overwriting
    // this.systemSsh at line 267 would orphan the old process.
    if (this.systemSsh) {
      this.systemSsh.kill()
      this.systemSsh = null
    }
    this.setState('connecting')

    try {
      const proc = spawnSystemSsh(this.target)
      this.systemSsh = proc

      // Why: two onExit handlers are registered — one for the initial handshake
      // (reject the promise on early exit) and one for post-connect reconnection.
      // Without a settled flag, an early exit during handshake would fire both,
      // causing the reconnection handler to schedule a reconnect for a connection
      // that was never established.
      let settled = false

      // Why: verify the SSH connection succeeded before reporting connected.
      // Wait for relay sentinel output or a non-zero exit.
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          settled = true
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

      // Why: unlike ssh2 Client which emits end/close, the system SSH process
      // only signals disconnection through its exit event. Without this handler
      // an unexpected exit would leave the connection in 'connected' state with
      // no underlying transport.
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
      this.reconnectTimer = null
    }
    if (this.client) {
      this.client.end()
      this.client = null
    }
    // Why: the jump host client holds an open TCP connection to the
    // intermediate host.  Failing to close it would leak the socket.
    if (this.jumpClient) {
      this.jumpClient.end()
      this.jumpClient = null
    }
    if (this.proxyProcess) {
      this.proxyProcess.kill()
      this.proxyProcess = null
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
