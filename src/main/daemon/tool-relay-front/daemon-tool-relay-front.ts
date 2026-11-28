// The loopback address a daemon start holds for the agents it keeps, so their tool calls reach Orca's
// relay across an app restart. The daemon never dials the app and never reads request bytes: each
// accepted connection is held until the app opens its own authenticated connection to the daemon
// for it (`tool-relay` hello), and the two are spliced.
import { randomUUID } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { DaemonToolRelayKeptGrants } from './daemon-tool-relay-kept-grants'
import type { ToolRelayFrontEventPayload } from '../protocol/daemon-tool-relay-front-protocol'

export const TOOL_RELAY_FRONT_HOLD_MS = 30_000
export const TOOL_RELAY_FRONT_MAX_HELD = 64
/** Keeps the front's whole share (below) under 400 descriptors, well inside a default limit. */
export const TOOL_RELAY_FRONT_MAX_PIPES = 128
/** Connections being answered 503 (each lingers briefly for its peer to read the answer). */
export const TOOL_RELAY_FRONT_MAX_ANSWERING = 64
/**
 * The front's share of the daemon's file descriptors, beside its terminals: the listener, one per
 * held or answering connection, two per pipe. Sizing it from the daemon's own descriptor limit is a
 * follow-up.
 */
export const TOOL_RELAY_FRONT_FD_BUDGET =
  1 + TOOL_RELAY_FRONT_MAX_HELD + TOOL_RELAY_FRONT_MAX_ANSWERING + 2 * TOOL_RELAY_FRONT_MAX_PIPES
/** How long an answered connection may stay open for its peer to read the answer. */
const ANSWER_LINGER_MS = 5_000

const RESTARTING_MESSAGE =
  'Orca is restarting, so this tool is briefly unavailable. Your session is still running. Wait a few seconds and try the tool again.'

/**
 * The 503 every answer from the front carries. Plain text: the daemon never reads the request, so
 * a JSON-RPC error could name no id, and an MCP client drops an id-less error and waits out its own
 * timeout; a non-JSON error fails the call at once with this text.
 */
function toolRelayRestartingAnswer(): string {
  return [
    'HTTP/1.1 503 Service Unavailable',
    'Content-Type: text/plain; charset=utf-8',
    'Retry-After: 5',
    `Content-Length: ${Buffer.byteLength(RESTARTING_MESSAGE)}`,
    'Connection: close',
    '',
    RESTARTING_MESSAGE
  ].join('\r\n')
}

type Held = { socket: Socket; timer: ReturnType<typeof setTimeout> }
type Pipe = { front: Socket; app: Socket; clientId: string }
type Serving = {
  clientId: string
  control: Socket
  announce: (payload: ToolRelayFrontEventPayload) => void
}

export class DaemonToolRelayFront {
  private server: Server | null = null
  private listening: Promise<number> | null = null
  private port: number | null = null
  private serving: Serving | null = null
  private disposed = false
  private readonly held = new Map<string, Held>()
  private readonly pipes = new Set<Pipe>()
  /** Connections answered 503 that their peer may still be reading. */
  private readonly answering = new Set<Socket>()
  /** Control connections whose close already ends their serving. */
  private readonly watchedControls = new WeakSet<Socket>()
  /** The grants of the agents this start keeps, for their relays' life. */
  readonly kept = new DaemonToolRelayKeptGrants()

  constructor(
    /** The daemon start holding this front. */
    readonly daemonInstance: string,
    private readonly holdMs = TOOL_RELAY_FRONT_HOLD_MS,
    private readonly fdBudget = TOOL_RELAY_FRONT_FD_BUDGET
  ) {}

  /** Descriptors the front holds now: the listener, one per held or answering connection, two per pipe. */
  get descriptorCount(): number {
    return (this.server ? 1 : 0) + this.held.size + this.answering.size + 2 * this.pipes.size
  }

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
        if (this.disposed) {
          server.close()
          reject(new Error('Tool relay front closed'))
          return
        }
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
    announce: (payload: ToolRelayFrontEventPayload) => void
  ): number | null {
    const replaced = this.serving?.control !== control
    if (!this.watchedControls.has(control)) {
      this.watchedControls.add(control)
      control.once('close', () => this.clientGone(clientId, control))
    }
    this.serving = { clientId, control, announce }
    // The same connection serving again already heard of every held connection.
    if (replaced) {
      for (const frontConnectionId of this.held.keys()) {
        announce({ frontConnectionId })
      }
    }
    return this.port
  }

  /** Whether the connection is still held, waiting for the app. */
  holds(frontConnectionId: string): boolean {
    return this.held.has(frontConnectionId)
  }

  /** A kept agent's relay ended: its grants go, and the app serving the front hears so. */
  forgetKept(relayId: string): void {
    if (this.kept.forget(relayId)) {
      this.serving?.announce({ keptEnded: relayId })
    }
  }

  /** An app's control connection closed: it answers nothing more, and its pipes close. */
  clientGone(clientId: string, control?: Socket): void {
    // A replaced control's close leaves its successor's pipes alone.
    if (control && this.serving?.clientId === clientId && this.serving.control !== control) {
      return
    }
    if (this.serving?.clientId === clientId) {
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
    // An app no longer serving answers nothing; the call stays held for the next one.
    if (!held || this.serving?.clientId !== clientId) {
      app.destroy()
      return false
    }
    this.held.delete(frontConnectionId)
    clearTimeout(held.timer)
    const front = held.socket
    // No longer held, so its pipe adds both sockets.
    if (this.pipes.size >= TOOL_RELAY_FRONT_MAX_PIPES || this.descriptorCount + 2 > this.fdBudget) {
      app.destroy()
      this.answerAndClose(front)
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
    this.kept.clear()
    for (const held of this.held.values()) {
      clearTimeout(held.timer)
      held.socket.destroy()
    }
    this.held.clear()
    for (const pipe of this.pipes) {
      closePipe(pipe)
    }
    this.pipes.clear()
    for (const socket of this.answering) {
      socket.destroy()
    }
    this.answering.clear()
    this.server?.close()
    this.server = null
  }

  private accept(socket: Socket): void {
    socket.on('error', () => socket.destroy())
    // The accepted socket is already open: past the budget it closes at once, unanswered.
    if (this.descriptorCount + 1 > this.fdBudget) {
      socket.destroy()
      return
    }
    if (this.held.size >= TOOL_RELAY_FRONT_MAX_HELD || this.disposed) {
      this.answerAndClose(socket)
      return
    }
    const id = randomUUID()
    const timer = setTimeout(() => {
      if (this.held.get(id)?.socket === socket) {
        this.held.delete(id)
        this.answerAndClose(socket)
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
    this.serving?.announce({ frontConnectionId: id })
  }

  /**
   * Answers without reading the request; unread bytes are discarded so the close sends no reset.
   * Past the answering cap the socket is closed with no answer, so refusals never pile up.
   */
  private answerAndClose(socket: Socket): void {
    if (socket.destroyed) {
      return
    }
    if (
      this.answering.size >= TOOL_RELAY_FRONT_MAX_ANSWERING ||
      this.descriptorCount + 1 > this.fdBudget ||
      this.disposed
    ) {
      socket.destroy()
      return
    }
    this.answering.add(socket)
    socket.end(toolRelayRestartingAnswer())
    socket.resume()
    const linger = setTimeout(() => socket.destroy(), ANSWER_LINGER_MS)
    linger.unref?.()
    socket.once('close', () => {
      clearTimeout(linger)
      this.answering.delete(socket)
    })
  }
}

function closePipe({ front, app }: Pipe): void {
  front.destroy()
  app.destroy()
}
