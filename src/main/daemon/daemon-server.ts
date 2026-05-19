import { createServer, type Server, type Socket } from 'net'
import { randomUUID } from 'crypto'
import { writeFileSync, chmodSync, unlinkSync } from 'fs'
import { encodeNdjson, createNdjsonParser } from './ndjson'
import { TerminalHost } from './terminal-host'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { SubprocessHandle } from './session'
import {
  PROTOCOL_VERSION,
  NOTIFY_PREFIX,
  SessionNotFoundError,
  type HelloMessage,
  type DaemonRequest
} from './types'

export type DaemonServerOptions = {
  socketPath: string
  tokenPath: string
  spawnSubprocess: (opts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
    shellOverride?: string
  }) => SubprocessHandle
}

type ConnectedClient = {
  clientId: string
  controlSocket: Socket
  streamSocket: Socket | null
}

export class DaemonServer {
  private server: Server | null = null
  private token: string
  private host: TerminalHost
  private socketPath: string
  private tokenPath: string

  private clients = new Map<string, ConnectedClient>()
  private streamDataBatcher = new DaemonStreamDataBatcher((clientId) => this.clients.get(clientId))

  constructor(opts: DaemonServerOptions) {
    this.socketPath = opts.socketPath
    this.tokenPath = opts.tokenPath
    this.token = randomUUID()
    this.host = new TerminalHost({ spawnSubprocess: opts.spawnSubprocess })
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket))

      this.server.on('error', (err) => {
        reject(err)
      })

      this.server.listen(this.socketPath, () => {
        writeFileSync(this.tokenPath, this.token, { mode: 0o600 })
        try {
          chmodSync(this.socketPath, 0o600)
        } catch {
          // Best-effort on platforms that support it
        }
        resolve()
      })
    })
  }

  async shutdown(): Promise<void> {
    this.host.dispose()
    this.streamDataBatcher.clear()

    for (const [, client] of this.clients) {
      client.controlSocket.destroy()
      client.streamSocket?.destroy()
    }
    this.clients.clear()

    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          try {
            unlinkSync(this.socketPath)
          } catch {}
          resolve()
        })
        this.server = null
      } else {
        resolve()
      }
    })
  }

  private handleConnection(socket: Socket): void {
    const parser = createNdjsonParser(
      (msg) => this.handleFirstMessage(socket, msg, parser),
      () => {
        socket.destroy()
      }
    )

    socket.on('data', (chunk) => parser.feed(chunk.toString()))
    socket.on('error', () => socket.destroy())
  }

  private handleFirstMessage(
    socket: Socket,
    msg: unknown,
    _parser: ReturnType<typeof createNdjsonParser>
  ): void {
    const hello = msg as HelloMessage
    if (hello.type !== 'hello') {
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Expected hello' }))
      socket.destroy()
      return
    }

    if (hello.version !== PROTOCOL_VERSION) {
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Protocol version mismatch' }))
      socket.destroy()
      return
    }

    if (hello.token !== this.token) {
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Invalid token' }))
      socket.destroy()
      return
    }

    socket.write(encodeNdjson({ type: 'hello', ok: true }))

    if (hello.role === 'control') {
      const client: ConnectedClient = {
        clientId: hello.clientId,
        controlSocket: socket,
        streamSocket: null
      }
      this.clients.set(hello.clientId, client)
      this.setupControlSocket(socket, hello.clientId)
    } else if (hello.role === 'stream') {
      const client = this.clients.get(hello.clientId)
      if (client) {
        client.streamSocket = socket
      }
      // Stream socket is receive-only from daemon's perspective (for events)
    }
  }

  private setupControlSocket(socket: Socket, clientId: string): void {
    const parser = createNdjsonParser(
      (msg) => this.handleRequest(socket, clientId, msg as DaemonRequest),
      () => {} // Ignore parse errors
    )

    // Remove the initial data listener and replace with the RPC parser
    socket.removeAllListeners('data')
    socket.on('data', (chunk) => parser.feed(chunk.toString()))

    socket.on('close', () => {
      this.streamDataBatcher.clear(clientId)
      this.clients.delete(clientId)
    })
  }

  private async handleRequest(
    socket: Socket,
    clientId: string,
    request: DaemonRequest
  ): Promise<void> {
    const isNotify = request.id.startsWith(NOTIFY_PREFIX)

    try {
      const result = await this.routeRequest(clientId, request)
      if (!isNotify) {
        socket.write(encodeNdjson({ id: request.id, ok: true, payload: result }))
      }
    } catch (err) {
      if (!isNotify) {
        socket.write(
          encodeNdjson({
            id: request.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
        )
      }
    }
  }

  private async routeRequest(clientId: string, request: DaemonRequest): Promise<unknown> {
    const client = this.clients.get(clientId)

    switch (request.type) {
      case 'createOrAttach': {
        const p = request.payload
        const result = await this.host.createOrAttach({
          sessionId: p.sessionId,
          cols: p.cols,
          rows: p.rows,
          cwd: p.cwd,
          env: p.env,
          command: p.command,
          shellOverride: p.shellOverride,
          terminalWindowsPowerShellImplementation: p.terminalWindowsPowerShellImplementation,
          shellReadySupported: p.shellReadySupported,
          streamClient: {
            onData: (data) => {
              this.streamDataBatcher.enqueue(clientId, p.sessionId, data)
            },
            onExit: (code) => {
              // Why: exit tears down renderer handlers; flush final output first
              // so the last few milliseconds of PTY data are not stranded.
              this.streamDataBatcher.flush(clientId)
              if (client?.streamSocket) {
                client.streamSocket.write(
                  encodeNdjson({
                    type: 'event',
                    event: 'exit',
                    sessionId: p.sessionId,
                    payload: { code }
                  })
                )
              }
            }
          }
        })
        return {
          isNew: result.isNew,
          snapshot: result.snapshot,
          pid: result.pid,
          shellState: result.shellState
        }
      }

      case 'write':
        try {
          this.host.write(request.payload.sessionId, request.payload.data)
        } catch (err) {
          if (err instanceof SessionNotFoundError) {
            this.sendExitEvent(client, request.payload.sessionId, -1)
          }
          throw err
        }
        return {}

      case 'resize':
        try {
          this.host.resize(request.payload.sessionId, request.payload.cols, request.payload.rows)
        } catch (err) {
          if (err instanceof SessionNotFoundError) {
            this.sendExitEvent(client, request.payload.sessionId, -1)
          }
          throw err
        }
        return {}

      case 'kill':
        this.host.kill(request.payload.sessionId)
        return {}

      case 'signal':
        this.host.signal(request.payload.sessionId, request.payload.signal)
        return {}

      case 'detach':
        // Note: detach token handling is simplified here — full implementation
        // would track tokens per client
        return {}

      case 'getCwd':
        return { cwd: await this.host.getCwd(request.payload.sessionId) }

      case 'clearScrollback':
        this.host.clearScrollback(request.payload.sessionId)
        return {}

      case 'listSessions':
        return { sessions: this.host.listSessions() }

      case 'getSnapshot':
        return { snapshot: this.host.getSnapshot(request.payload.sessionId) }

      case 'ping':
        return { pong: true }

      case 'shutdown':
        if (request.payload.killSessions) {
          this.host.dispose()
        }
        process.nextTick(() => this.shutdown())
        return {}

      default:
        throw new Error(`Unknown request type: ${(request as { type: string }).type}`)
    }
  }

  private sendExitEvent(
    client: ConnectedClient | undefined,
    sessionId: string,
    code: number
  ): void {
    if (!client?.streamSocket) {
      return
    }
    // Why: write/resize are notification-heavy and intentionally do not wait
    // for replies. If their target session is gone, this synthetic exit is the
    // only signal the renderer gets to clear stale terminal pane bindings.
    client.streamSocket.write(
      encodeNdjson({
        type: 'event',
        event: 'exit',
        sessionId,
        payload: { code }
      })
    )
  }
}
