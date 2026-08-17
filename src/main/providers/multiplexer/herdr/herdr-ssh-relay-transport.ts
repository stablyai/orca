import crypto from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { SshConnection } from '../../../ssh/ssh-connection'
import type { RemoteHostPlatform } from '../../../ssh/ssh-remote-platform'
import {
  HerdrRuntimeError,
  type HerdrHostTransport,
  type HerdrResponse,
  type HerdrTerminalController,
  type HerdrTerminalControlOptions,
  type HerdrTransportEvent
} from './herdr-runtime-contract'
import { HerdrSshSessionManager } from './herdr-ssh-session'
import { HerdrTransport } from './herdr-transport'
import { createHerdrSocketTerminalController } from './herdr-socket-terminal-control'
import { DEFAULT_HERDR_EVENT_SUBSCRIPTIONS } from './herdr-socket-events'
import type { HerdrSocketEvent } from './herdr-socket-types'

export class HerdrSshRelayTransport implements HerdrHostTransport {
  private readonly sessionManager: HerdrSshSessionManager
  private client: HerdrTransport | null = null
  private readonly eventListeners = new Set<(event: HerdrTransportEvent) => void>()
  private remoteHome: string | null = null

  constructor(
    private readonly connection: SshConnection,
    timeoutMs = 15_000,
    resolveExecutable: () => Promise<string> = async () => 'herdr',
    hostPlatform?: RemoteHostPlatform,
    sessionManager?: HerdrSshSessionManager
  ) {
    this.sessionManager =
      sessionManager ??
      new HerdrSshSessionManager(connection, timeoutMs, resolveExecutable, hostPlatform)
  }

  async ensureSession(sessionName: string): Promise<void> {
    if (this.client?.isConnected()) {
      return
    }

    await this.sessionManager.ensureSession(sessionName)

    if (!this.remoteHome) {
      this.remoteHome = await this.getRemoteHome()
    }

    const remoteSocketPath = `${this.remoteHome}/.config/herdr/sessions/${sessionName}/herdr.sock`

    const channel = await new Promise<Duplex>((resolve, reject) => {
      const sshClient = this.connection.getClient()
      if (!sshClient) {
        reject(
          new HerdrRuntimeError(
            'ssh_not_connected',
            'SSH client not available for socket forwarding'
          )
        )
        return
      }
      sshClient.openssh_forwardOutStreamLocal(remoteSocketPath, (err, stream) => {
        if (err) {
          reject(
            new HerdrRuntimeError(
              'ssh_forward_failed',
              `Failed to forward remote socket ${remoteSocketPath}: ${err.message}`
            )
          )
        } else {
          resolve(stream)
        }
      })
    })

    channel.on('error', () => {})

    this.client = new HerdrTransport()
    await this.client.connectWithStream(channel)

    this.client.on('event', (event: HerdrSocketEvent) => {
      for (const listener of this.eventListeners) {
        listener(event)
      }
    })

    await this.client.request('ping', {})
    await this.client.request('events.subscribe', {
      subscriptions: DEFAULT_HERDR_EVENT_SUBSCRIPTIONS
    })
  }

  async request<T>(
    _sessionName: string,
    method: string,
    params: unknown
  ): Promise<HerdrResponse<T>> {
    try {
      const result = await this.client!.request(method, params)
      return { id: crypto.randomUUID(), result: result as T }
    } catch (error) {
      return {
        id: crypto.randomUUID(),
        error: {
          code: error instanceof HerdrRuntimeError ? error.code : 'herdr_request_failed',
          message: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }

  controlTerminal(
    _sessionName: string,
    target: string,
    options: HerdrTerminalControlOptions
  ): HerdrTerminalController {
    if (!this.client?.isConnected()) {
      throw new HerdrRuntimeError(
        'not_connected',
        'Relay transport not connected for terminal control'
      )
    }
    return createHerdrSocketTerminalController(target, options, {
      request: <T>(method: string, params: unknown) =>
        this.client!.request(method, params) as Promise<T>,
      subscribeEvents: (listener) => this.onEvent(listener)
    })
  }

  onEvent(listener: (event: HerdrTransportEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  async disconnect(): Promise<void> {
    this.eventListeners.clear()
    if (this.client) {
      await this.client.close()
      this.client = null
    }
  }

  private async getRemoteHome(): Promise<string> {
    const result = await this.sessionManager.run(['sh', '-c', 'echo "$HOME"'])
    return result.trim() || '/home/unknown'
  }
}
