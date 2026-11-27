// The loopback address a daemon start holds for the agents it keeps, so their tool calls reach Orca's
// relay across an app restart. The daemon never dials the app and never reads request bytes: each
// accepted connection is held until the app opens its own authenticated connection to the daemon
// for it (`tool-relay` hello), and the two are spliced.
import { randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'

export const TOOL_RELAY_FRONT_HOLD_MS = 30_000
export const TOOL_RELAY_FRONT_MAX_HELD = 64
export const TOOL_RELAY_FRONT_MAX_PIPES = 256
/** How long an answered connection may stay open for its peer to read the answer. */
const ANSWER_LINGER_MS = 5_000

const RESTARTING_MESSAGE =
  'Orca is restarting, so this tool is briefly unavailable. Your session is still running. Wait a few seconds and try the tool again.'

/** The 503 every answer from the front carries; the daemon never reads the request, so no id. */
export function toolRelayRestartingAnswer(
  message = RESTARTING_MESSAGE,
  id: unknown = null
): string {
  const body = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })
  return [
    'HTTP/1.1 503 Service Unavailable',
    'Content-Type: application/json',
    'Retry-After: 5',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
    '',
    body
  ].join('\r\n')
}

type Held = { socket: Socket; timer: ReturnType<typeof setTimeout> }
type Pipe = { front: Socket; app: Socket; clientId: string }
type Serving = {
  clientId: string
  control: Socket
  announce: (frontConnectionId: string) => void
}

export class DaemonToolRelayFront {
  private server: Server | null = null
  private listening: Promise<number> | null = null
  private port: number | null = null
  private serving: Serving | null = null
  private disposed = false
  private readonly held = new Map<string, Held>()
  private readonly pipes = new Set<Pipe>()

  constructor(
    /** The daemon start holding this front. */
    readonly daemonInstance: string,
    private readonly holdMs = TOOL_RELAY_FRONT_HOLD_MS
  ) {}

  /** This start's front port, listening from the first ask until the daemon exits. */
  open(): Promise<number> {
    if (this.disposed) {
      return Promise.reject(new Error('Tool relay front closed'))
    }
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer({ pauseOnConnect: true }, (socket) => this.accept(socket))
      server.once('error', (error) => {
        this.listening = null
        reject(error)
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        server.unref()
        this.server = server
        this.port = address && typeof address === 'object' ? address.port : null
        if (this.port === null) {
          server.close()
          this.listening = null
          reject(new Error('Tool relay front has no port'))
          return
        }
        resolve(this.port)
      })
    })
    return this.listening
  }

  /**
   * The app that answers this front's connections, until its control connection closes; replaces
   * any earlier one. Null: no front yet.
   */
  serve(
    clientId: string,
    control: Socket,
    announce: (frontConnectionId: string) => void
  ): number | null {
    if (this.serving?.control !== control) {
      control.once('close', () => this.clientGone(clientId, control))
    }
    this.serving = { clientId, control, announce }
    for (const id of this.held.keys()) {
      announce(id)
    }
    return this.port
  }

  /** An app's control connection closed: it answers nothing more, and its pipes close. */
  clientGone(clientId: string, control?: Socket): void {
    if (this.serving?.clientId === clientId && (!control || this.serving.control === control)) {
      this.serving = null
    }
    for (const pipe of this.pipes) {
      if (pipe.clientId === clientId) {
        this.pipes.delete(pipe)
        closePipe(pipe)
      }
    }
  }

  /** Joins a held connection to the app's authenticated one; false when it is no longer held. */
  splice(frontConnectionId: string, app: Socket, clientId: string): boolean {
    const held = this.held.get(frontConnectionId)
    if (!held) {
      app.destroy()
      return false
    }
    this.held.delete(frontConnectionId)
    clearTimeout(held.timer)
    const front = held.socket
    if (this.pipes.size >= TOOL_RELAY_FRONT_MAX_PIPES) {
      app.destroy()
      answerAndClose(front)
      return false
    }
    const pipe: Pipe = { front, app, clientId }
    this.pipes.add(pipe)
    const close = (): void => {
      this.pipes.delete(pipe)
      closePipe(pipe)
    }
    for (const socket of [front, app]) {
      socket.once('close', close)
      socket.on('error', close)
    }
    front.pipe(app)
    app.pipe(front)
    app.resume()
    return true
  }

  get heldCount(): number {
    return this.held.size
  }

  get pipeCount(): number {
    return this.pipes.size
  }

  dispose(): void {
    this.disposed = true
    this.serving = null
    for (const held of this.held.values()) {
      clearTimeout(held.timer)
      held.socket.destroy()
    }
    this.held.clear()
    for (const pipe of this.pipes) {
      closePipe(pipe)
    }
    this.pipes.clear()
    this.server?.close()
    this.server = null
  }

  private accept(socket: Socket): void {
    socket.on('error', () => socket.destroy())
    if (this.held.size >= TOOL_RELAY_FRONT_MAX_HELD || this.disposed) {
      answerAndClose(socket)
      return
    }
    const id = randomUUID()
    const timer = setTimeout(() => {
      if (this.held.get(id)?.socket === socket) {
        this.held.delete(id)
        answerAndClose(socket)
      }
    }, this.holdMs)
    timer.unref?.()
    this.held.set(id, { socket, timer })
    socket.once('close', () => {
      const held = this.held.get(id)
      if (held?.socket === socket) {
        clearTimeout(held.timer)
        this.held.delete(id)
      }
    })
    this.serving?.announce(id)
  }
}

function closePipe({ front, app }: Pipe): void {
  front.destroy()
  app.destroy()
}

/** Answers without reading the request; unread bytes are discarded so the close sends no reset. */
function answerAndClose(socket: Socket): void {
  if (socket.destroyed) {
    return
  }
  socket.end(toolRelayRestartingAnswer())
  socket.resume()
  const linger = setTimeout(() => socket.destroy(), ANSWER_LINGER_MS)
  linger.unref?.()
  socket.once('close', () => clearTimeout(linger))
}
