// Relay `lsp.*` method family (ticket 17, spec §4 relay row + D6/D8). A raw
// stdio subprocess channel — NOT a PTY: clangd runs as a detached relay-daemon
// child with stdin/stdout/stderr pipes (no terminal allocation, no echo). The
// credit backpressure on stdout mirrors the pty ack model (see
// lsp-credit-window.ts); disconnect only DETACHES the session (the child keeps
// running) per the SSH execution-boundary rule — loss of contact is `unverifiable`,
// never `exited`.
//
// Wire compatibility (docs/reference/remote-wire-compatibility.md):
//  - `lsp.spawn/write/kill` are NEW request methods. An old relay answers
//    `method_not_found` (-32601) for each, so a new client detects absence and
//    degrades gracefully instead of hanging.
//  - `lsp.data/stderr/exit` are NEW client-bound notifications. An old client
//    that never registered them drops the frames silently (Rule 2: unknown
//    notification methods are ignored by the dispatcher's notification handler
//    map). The new client only subscribes after a successful `lsp.spawn`, so the
//    path is audited: an old relay never emits them, and an old client never
//    receives them from a new relay without first having called `lsp.spawn`.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { terminateRelaySubprocessTree } from './subprocess-tree-termination'
import { LspCreditWindow } from './lsp-credit-window'
import type { RelayDispatcher, RequestContext } from './dispatcher'

/** Spawn seam — production uses node:child_process.spawn; tests inject a fake
 *  so the credit/backpressure/notification logic is exercised without a real
 *  clangd. Mirrors the `spawnImpl` seam on openNativeLanguageServerProcess. */
export type LspSpawnFn = (
  program: string,
  args: readonly string[],
  options: {
    cwd?: string
    env: NodeJS.ProcessEnv
    stdio: ['pipe', 'pipe', 'pipe']
    detached: boolean
    windowsHide?: boolean
  }
) => ChildProcess

const defaultSpawn: LspSpawnFn = (program, args, options) =>
  spawn(program, args as string[], options)

/** Mint-epoch segment of every session id. A relay restart mints a new epoch, so
 *  a session id from an incumbent relay is never reused by its successor — the
 *  client treats a not-found id as `unverifiable`, never as a live session. */
const LSP_MINT_EPOCH = randomUUID()

/** Max base64 chunk size per `lsp.data` frame (raw 256KB → ~340KB base64, under
 *  MAX_MESSAGE_SIZE). Matches STREAM_CHUNK_SIZE so a bulk LSP stdout frame and a
 *  bulk fs stream frame cost the same on the shared SSH channel. */
const LSP_DATA_CHUNK_BYTES = 256 * 1024

/** Idle grace before an unowned LSP session is swept. 0 = keep alive until
 *  reset, mirroring the PTY default-grace policy (disconnect detaches, never
 *  disposes). The sweep is a safety valve, not a feature. */
const LSP_IDLE_GRACE_MS = 0

export type LspSpawnParams = {
  program: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

type ManagedLspSession = {
  sessionId: string
  child: ChildProcess
  /** Owning client — notifications are targeted here. */
  clientId: number
  /** Detached: the client disconnected; the child keeps running. */
  detached: boolean
  stdoutPaused: boolean
  credit: LspCreditWindow
  stderrBuffer: string
  /** Resolved once the child emits 'exit' (host-owned evidence of death). */
  exited: boolean
}

/**
 * Spawns and manages raw-stdio LSP subprocesses on the relay host. Each
 * `lsp.spawn` starts clangd as a detached child (stdio pipes); stdout is
 * streamed back as credit-controlled `lsp.data` frames, stderr as
 * `lsp.stderr`, and the terminal event as `lsp.exit`. A client disconnect
 * detaches the session (the child survives) — reattach is a v2 lease model
 * (spec D6: "`lsp.attach` 租约模型为 v2 优化"), so v1 leaves a detached
 * session running under the idle grace sweep.
 */
export class LspHandler {
  private readonly dispatcher: RelayDispatcher
  private readonly spawnImpl: LspSpawnFn
  private readonly sessions = new Map<string, ManagedLspSession>()
  /** Buffered stdout held while the credit window was closed (never a partial frame). */
  private readonly pendingStdout = new Map<string, Buffer>()
  private nextSessionSequence = 1

  constructor(dispatcher: RelayDispatcher, spawnImpl: LspSpawnFn = defaultSpawn) {
    this.dispatcher = dispatcher
    this.spawnImpl = spawnImpl
    this.registerHandlers()
    // Detach every owned session when the dispatcher tears down (relay quit),
    // so clangd is not killed by the relay process exiting — execution-boundary:
    // the child's life belongs to the host, not the relay process.
    this.dispatcher.onDisposed(() => this.detachAllSessions())
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('lsp.spawn', (p, context) => this.spawn(p, context))
    this.dispatcher.onRequest('lsp.kill', (p) => this.kill(p))
    // `lsp.write` is a notification (fire-and-forget stdin); registered below.
    this.dispatcher.onNotification('lsp.write', (p) => this.write(p))
    // `lsp.ack` is a client→relay notification releasing the credit window.
    this.dispatcher.onNotification('lsp.ack', (p) => this.ack(p))
  }

  private mintSessionId(): string {
    return `lsp:${encodeURIComponent(LSP_MINT_EPOCH)}:${this.nextSessionSequence++}`
  }

  /** Test seam: the mint epoch so tests can assert incarnation-bound ids. */
  mintEpoch(): string {
    return LSP_MINT_EPOCH
  }

  private async spawn(
    params: Record<string, unknown>,
    context: RequestContext
  ): Promise<{ sessionId: string }> {
    const program = typeof params.program === 'string' ? params.program : ''
    if (!program) {
      throw new Error('lsp.spawn requires a non-empty "program"')
    }
    const args = Array.isArray(params.args)
      ? params.args.filter((a): a is string => typeof a === 'string')
      : []
    const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : undefined
    const envRecord =
      params.env && typeof params.env === 'object'
        ? Object.fromEntries(
            Object.entries(params.env as Record<string, unknown>).filter(
              ([, v]) => typeof v === 'string'
            )
          )
        : undefined
    const env: NodeJS.ProcessEnv | undefined = envRecord
      ? (envRecord as Record<string, string>)
      : undefined

    const sessionId = this.mintSessionId()
    const child = this.spawnImpl(program, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Detached so the child survives a relay-client disconnect (execution
      // boundary: disconnect detaches, never disposes). `unref` keeps the relay's
      // event loop from keeping clangd alive — but the child's own stdio pipes
      // hold it until the client closes them or kill is called.
      detached: true,
      ...(process.platform === 'win32' ? { windowsHide: true } : {})
    })
    child.unref()

    const credit = new LspCreditWindow()
    const session: ManagedLspSession = {
      sessionId,
      child,
      clientId: context.clientId,
      detached: false,
      stdoutPaused: false,
      credit,
      stderrBuffer: '',
      exited: false
    }
    this.sessions.set(sessionId, session)

    child.stdout?.on('data', (chunk: Buffer) => this.handleStdout(session, chunk))
    child.stderr
      ?.setEncoding('utf8')
      .on('data', (chunk: string) => this.handleStderr(session, chunk))
    child.on('exit', (code, signal) => this.handleExit(session, code, signal))
    // Why no-op: an EPIPE during teardown (client gone, stdin pipe closed) must
    // not crash the relay; the exit ladder still runs.
    child.stdin?.on('error', () => {})
    child.on('error', (error) => {
      // A spawn failure (ENOENT) surfaces here before 'exit'; publish it as an
      // exit with an error-shaped signal so the client sees termination.
      if (!session.exited) {
        this.handleExit(session, null, `error:${error.message}`)
      }
    })

    return { sessionId }
  }

  private handleStdout(session: ManagedLspSession, chunk: Buffer): void {
    if (session.exited || session.detached) {
      return
    }
    // Credit backpressure: if the window is exhausted (a prior send filled it),
    // pause the stdout pipe so the relay does not flood the SSH channel; the
    // client's `lsp.ack` reopens it. Buffer the chunk whole — a partial frame
    // would desync the LSP Content-Length parser.
    if (session.credit.shouldPause()) {
      this.pendingStdout.set(
        session.sessionId,
        Buffer.concat([this.pendingStdout.get(session.sessionId) ?? Buffer.alloc(0), chunk])
      )
      if (!session.stdoutPaused) {
        session.stdoutPaused = true
        session.child.stdout?.pause()
      }
      return
    }
    for (let offset = 0; offset < chunk.length; offset += LSP_DATA_CHUNK_BYTES) {
      const slice = chunk.subarray(offset, offset + LSP_DATA_CHUNK_BYTES)
      const seq = session.credit.nextOutboundSeq()
      this.dispatcher.publishProducerNotification(session.clientId, 'lsp.data', {
        sessionId: session.sessionId,
        seq,
        data: slice.toString('base64')
      })
      session.credit.recordSent()
      // After this send the window may be full: pause and buffer the remainder.
      if (session.credit.shouldPause() && offset + LSP_DATA_CHUNK_BYTES < chunk.length) {
        const remainder = chunk.subarray(offset + LSP_DATA_CHUNK_BYTES)
        this.pendingStdout.set(
          session.sessionId,
          Buffer.concat([this.pendingStdout.get(session.sessionId) ?? Buffer.alloc(0), remainder])
        )
        session.stdoutPaused = true
        session.child.stdout?.pause()
        break
      }
    }
  }

  private handleStderr(session: ManagedLspSession, chunk: string): void {
    if (session.exited || session.detached) {
      return
    }
    // Line-buffer stderr so half-line writes never garble the log tail (mirrors
    // native-language-server-process.ts).
    session.stderrBuffer += chunk
    const lines = session.stderrBuffer.split(/\r?\n/)
    session.stderrBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (line) {
        this.dispatcher.publishProducerNotification(session.clientId, 'lsp.stderr', {
          sessionId: session.sessionId,
          line
        })
      }
    }
  }

  private handleExit(session: ManagedLspSession, code: number | null, signal: string | null): void {
    if (session.exited) {
      return
    }
    session.exited = true
    // Flush any buffered stderr line so the client sees the final log output.
    if (session.stderrBuffer) {
      this.dispatcher.publishProducerNotification(session.clientId, 'lsp.stderr', {
        sessionId: session.sessionId,
        line: session.stderrBuffer
      })
      session.stderrBuffer = ''
    }
    this.dispatcher.publishProducerNotification(session.clientId, 'lsp.exit', {
      sessionId: session.sessionId,
      code,
      signal
    })
    this.sessions.delete(session.sessionId)
    this.pendingStdout.delete(session.sessionId)
  }

  private write(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const session = this.sessions.get(sessionId)
    if (!session || session.exited) {
      return
    }
    const data = typeof params.data === 'string' ? params.data : ''
    if (!data) {
      return
    }
    // stdin is base64-encoded on the wire (binary-safe); the client paces its
    // own writes so no credit window is needed on this direction.
    try {
      session.child.stdin?.write(Buffer.from(data, 'base64'))
    } catch {
      // stdin may be closed (clangd exited mid-write); the exit ladder handles it.
    }
  }

  private ack(params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const session = this.sessions.get(sessionId)
    if (!session || session.exited || session.detached) {
      return
    }
    const seq = typeof params.seq === 'number' ? params.seq : Number(params.seq)
    if (!Number.isInteger(seq)) {
      return
    }
    const reopened = session.credit.recordAck(seq)
    if (reopened && session.stdoutPaused) {
      session.stdoutPaused = false
      session.child.stdout?.resume()
      // Flush buffered stdout that was held while the window was closed.
      const buffered = this.pendingStdout.get(session.sessionId)
      if (buffered && buffered.length > 0) {
        this.pendingStdout.delete(session.sessionId)
        this.handleStdout(session, buffered)
      }
    }
  }

  private async kill(params: Record<string, unknown>): Promise<{ killed: boolean }> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : ''
    const session = this.sessions.get(sessionId)
    if (!session) {
      // Not-found is `unverifiable` per execution-boundary, but `lsp.kill` is an
      // explicit client action — answer honestly that there was nothing to kill.
      return { killed: false }
    }
    if (session.exited) {
      return { killed: true }
    }
    terminateRelaySubprocessTree(session.child)
    return { killed: true }
  }

  /** Detach every session (relay quit): the children survive — execution boundary. */
  detachAllSessions(): void {
    for (const session of this.sessions.values()) {
      session.detached = true
      // Stop reading so a detached child's stdout does not pile up unbounded.
      session.child.stdout?.pause()
    }
  }

  /** Test seam: live session count. */
  get sessionCount(): number {
    return this.sessions.size
  }

  /** Idle grace accessor — 0 keeps sessions alive until reset (mirrors PTY default). */
  idleGraceMs(): number {
    return LSP_IDLE_GRACE_MS
  }
}
