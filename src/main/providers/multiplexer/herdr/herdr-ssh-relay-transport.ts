import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
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

import {
  createHerdrSessionControlFromOpen,
  herdrSessionControlArgs,
  herdrSessionControlStreamFromChannel
} from './herdr-session-control'
import { DEFAULT_HERDR_EVENT_SUBSCRIPTIONS } from './herdr-socket-events'
import type { HerdrSocketEvent } from './herdr-socket-types'

export class HerdrSshRelayTransport implements HerdrHostTransport {
  private readonly sessionManager: HerdrSshSessionManager
  private readonly timeoutMs: number
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
    this.timeoutMs = timeoutMs
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
    sessionName: string,
    target: string,
    options: HerdrTerminalControlOptions
  ): HerdrTerminalController {
    return createHerdrSessionControlFromOpen(async () =>
      herdrSessionControlStreamFromChannel(
        await this.sessionManager.open(herdrSessionControlArgs(sessionName, target, options))
      )
    )
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
    const channel = await this.connection.exec('printf %s "$HOME"')
    return await new Promise((resolve, reject) => {
      let stdout = ''
      const timeout = setTimeout(() => {
        channel.close()
        reject(new Error(`Remote HOME lookup timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      channel.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      channel.once('error', (error: Error) => {
        clearTimeout(timeout)
        reject(error)
      })
      channel.once('close', () => {
        clearTimeout(timeout)
        resolve(stdout.trim() || '/home/unknown')
      })
      channel.end()
    })
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const REQUEST_TIMEOUT_MS = 30_000

class HerdrTransport extends EventEmitter {
  private socket: Duplex | null = null
  private buffer = ''
  private pendingRequests = new Map<string, PendingRequest>()
  private messageId = 0

  async connectWithStream(stream: Duplex): Promise<void> {
    if (this.socket) {
      throw new HerdrRuntimeError('already_connected', 'Transport already connected')
    }
    this.socket = stream
    this.setupSocket(stream)
    if ('readyState' in stream && stream.readyState === 'opening') {
      await new Promise<void>((resolve, reject) => {
        stream.once('connect', () => resolve())
        stream.once('error', reject)
      })
    }
  }

  private setupSocket(socket: Duplex): void {
    socket.on('data', (data) => {
      this.buffer += data.toString('utf8')
      this.processBuffer()
    })
    socket.on('close', () => {
      this.socket = null
      this.emit('disconnect')
    })
    socket.on('error', (err) => {
      this.emit('error', err)
    })
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) {
        continue
      }
      try {
        const message = JSON.parse(line) as Record<string, unknown>
        if ('id' in message && ('result' in message || 'error' in message)) {
          this.handleResponse(
            message as { id: string; result?: unknown; error?: { code: string; message: string } }
          )
        } else if ('method' in message) {
          this.emit('notification', message)
        } else if ('event' in message) {
          this.emit('event', message)
        }
      } catch {
        // Ignore malformed messages
      }
    }
  }

  private handleResponse(response: {
    id: string
    result?: unknown
    error?: { code: string; message: string } | null
  }): void {
    const pending = this.pendingRequests.get(response.id)
    if (!pending) {
      return
    }
    this.pendingRequests.delete(response.id)
    clearTimeout(pending.timeout)
    if (response.error) {
      pending.reject(new HerdrRuntimeError(response.error.code, response.error.message))
    } else {
      pending.resolve(response.result)
    }
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (!this.isConnected() || !this.socket) {
      throw new HerdrRuntimeError('not_connected', 'Transport not connected')
    }
    const id = String(++this.messageId)
    const socket = this.socket
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new HerdrRuntimeError('request_timeout', `Request ${method} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pendingRequests.set(id, { resolve, reject, timeout })
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
  }

  async close(): Promise<void> {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new HerdrRuntimeError('transport_closed', 'Transport closed'))
    }
    this.pendingRequests.clear()
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
  }

  isConnected(): boolean {
    if (!this.socket) {
      return false
    }
    if ('readyState' in this.socket) {
      return this.socket.readyState === 'open'
    }
    return !this.socket.destroyed
  }
}
