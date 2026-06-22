/* eslint-disable max-lines -- Why: this class owns the daemon socket protocol,
   request routing, stream fanout, and session lifecycle in one place so
   renderer/daemon request semantics stay auditable across platform branches. */
import { createServer, type Server, type Socket } from 'net'
import { randomUUID } from 'crypto'
import { performance } from 'perf_hooks'
import { writeFileSync, chmodSync, unlinkSync } from 'fs'
import { StringDecoder } from 'string_decoder'
import { encodeNdjson, createNdjsonParser } from './ndjson'
import { TerminalHost } from './terminal-host'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import { readCurrentProcessMacSystemResolverHealth } from '../network/macos-system-resolver-health'
import type { SubprocessHandle } from './session'
import { checkPtySpawnHealth } from './pty-subprocess'
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
  ptySpawnHealthCheck?: () => Promise<void>
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
  private ptySpawnHealthCheck: () => Promise<void>

  private clients = new Map<string, ConnectedClient>()
  private streamDataBatcher = new DaemonStreamDataBatcher((clientId) => this.clients.get(clientId))
  private lastInputAtBySessionId = new Map<string, number>()

  // Why: main-process PTY IPC has the same recent-input bypass, but daemon
  // output reaches main only after this stream layer. Keeping the window here
  // removes the daemon's fixed batch delay from keystroke echo/redraws while
  // preserving batching for background and large output.
  private static readonly INTERACTIVE_OUTPUT_WINDOW_MS = 100
  private static readonly INTERACTIVE_OUTPUT_MAX_CHARS = 1024

  constructor(opts: DaemonServerOptions) {
    this.socketPath = opts.socketPath
    this.tokenPath = opts.tokenPath
    this.token = randomUUID()
    this.host = new TerminalHost({ spawnSubprocess: opts.spawnSubprocess })
    this.ptySpawnHealthCheck = opts.ptySpawnHealthCheck ?? checkPtySpawnHealth
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket))
      const onListenError = (err: Error): void => {
        reject(err)
      }

      this.server.once('error', onListenError)

      this.server.listen(this.socketPath, () => {
        // Why: after bind, steady-state socket errors are handled per client;
        // the startup promise listener would otherwise retain this closure.
        this.server?.off('error', onListenError)
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
    // Why: clients can send multibyte prompt/input text split across socket
    // chunks; keep UTF-8 sequences intact before NDJSON parsing.
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (msg) => this.handleFirstMessage(socket, msg, parser),
      () => {
        socket.destroy()
      }
    )

    socket.on('data', (chunk) => parser.feed(decoder.write(chunk)))
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
      const previous = this.clients.get(hello.clientId)
      const client: ConnectedClient = {
        clientId: hello.clientId,
        controlSocket: socket,
        streamSocket: null
      }
      this.clients.set(hello.clientId, client)
      this.setupControlSocket(socket, hello.clientId)
      if (previous) {
        // Why: a reconnect can reuse a clientId before the old sockets notice
        // their close. Tear them down after installing the new owner so stale
        // close events cannot delete the replacement client entry.
        previous.streamSocket?.destroy()
        previous.controlSocket.destroy()
      }
    } else if (hello.role === 'stream') {
      const client = this.clients.get(hello.clientId)
      if (!client) {
        // Why: stream sockets are only meaningful beside a control socket; an
        // orphan stream would otherwise stay open with no tracked owner.
        socket.destroy()
        return
      }
      this.setupStreamSocket(socket, client)
    }
  }

  private setupControlSocket(socket: Socket, clientId: string): void {
    // Why: terminal writes and startup commands can contain emoji/Unicode.
    // Decoding per Buffer would corrupt split multibyte sequences.
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (msg) => this.handleRequest(socket, clientId, msg as DaemonRequest),
      () => {} // Ignore parse errors
    )

    // Remove the initial data listener and replace with the RPC parser
    socket.removeAllListeners('data')
    socket.on('data', (chunk) => parser.feed(decoder.write(chunk)))

    socket.on('close', () => {
      const client = this.clients.get(clientId)
      if (client?.controlSocket !== socket) {
        return
      }
      this.streamDataBatcher.clear(clientId)
      client.streamSocket?.destroy()
      this.clients.delete(clientId)
    })
  }

  private setupStreamSocket(socket: Socket, client: ConnectedClient): void {
    const previous = client.streamSocket
    socket.removeAllListeners('data')
    client.streamSocket = socket

    const cleanup = (): void => {
      socket.removeListener('close', cleanup)
      socket.removeListener('error', cleanup)
      if (this.clients.get(client.clientId) !== client || client.streamSocket !== socket) {
        return
      }
      this.streamDataBatcher.clear(client.clientId)
      client.streamSocket = null
    }

    socket.on('close', cleanup)
    socket.on('error', cleanup)

    if (previous && previous !== socket) {
      // Why: replacing a stream socket must not leave the old receive-only
      // channel alive and untracked.
      previous.destroy()
    }
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
          envToDelete: p.envToDelete,
          command: p.command,
          startupCommandDelivery: p.startupCommandDelivery,
          shellOverride: p.shellOverride,
          terminalWindowsWslDistro: p.terminalWindowsWslDistro,
          terminalWindowsPowerShellImplementation: p.terminalWindowsPowerShellImplementation,
          shellReadySupported: p.shellReadySupported,
          ...(p.shellReadyTimeoutMs !== undefined
            ? { shellReadyTimeoutMs: p.shellReadyTimeoutMs }
            : {}),
          streamClient: {
            onData: (data) => {
              const lastInputAt = this.lastInputAtBySessionId.get(p.sessionId)
              const isInteractiveOutput =
                data.length <= DaemonServer.INTERACTIVE_OUTPUT_MAX_CHARS &&
                lastInputAt !== undefined &&
                performance.now() - lastInputAt <= DaemonServer.INTERACTIVE_OUTPUT_WINDOW_MS
              this.streamDataBatcher.enqueue(clientId, p.sessionId, data, {
                flushImmediately: isInteractiveOutput,
                flushMaxChars: DaemonServer.INTERACTIVE_OUTPUT_MAX_CHARS
              })
            },
            onExit: (code) => {
              // Why: exit tears down renderer handlers; flush final output first
              // so the last few milliseconds of PTY data are not stranded.
              this.streamDataBatcher.flush(clientId)
              this.lastInputAtBySessionId.delete(p.sessionId)
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

      case 'cancelCreateOrAttach':
        return {}

      case 'write':
        try {
          this.lastInputAtBySessionId.set(request.payload.sessionId, performance.now())
          this.host.write(request.payload.sessionId, request.payload.data)
        } catch (err) {
          this.lastInputAtBySessionId.delete(request.payload.sessionId)
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
        this.lastInputAtBySessionId.delete(request.payload.sessionId)
        this.host.kill(request.payload.sessionId, { immediate: request.payload.immediate })
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

      case 'getForegroundProcess':
        return { foregroundProcess: this.host.getForegroundProcess(request.payload.sessionId) }

      case 'clearScrollback':
        this.host.clearScrollback(request.payload.sessionId)
        return {}

      case 'listSessions':
        return { sessions: this.host.listSessions() }

      case 'getSnapshot':
        return { snapshot: this.host.getSnapshot(request.payload.sessionId) }

      case 'takePendingOutput':
        // Why no await before this call: with includeSnapshot, drain and
        // serialize must share one synchronous turn — an intervening await
        // would let PTY data land in between, and cold restore would replay
        // those bytes on top of a snapshot that already contains them.
        return this.host.takePendingOutput(
          request.payload.sessionId,
          request.payload.includeSnapshot === true,
          { teardownSnapshot: request.payload.teardownSnapshot === true }
        )

      case 'ping':
        return { pong: true }

      case 'systemResolverHealth':
        return { health: await readCurrentProcessMacSystemResolverHealth() }

      case 'ptySpawnHealth':
        await this.ptySpawnHealthCheck()
        return { healthy: true }

      case 'shutdown':
        if (request.payload.killSessions) {
          this.host.dispose()
        }
        process.nextTick(() => this.shutdown())
        return {}
    }
    throw new Error(`Unknown request type: ${(request as { type: string }).type}`)
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
