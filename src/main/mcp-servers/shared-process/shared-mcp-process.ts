// One command server Orca runs once on the host for every agent session that uses it. Orca is the
// child's only MCP client; each agent's MCP session over the relay gets its own server end that
// answers initialize from the child's own and passes every other request and notification through.
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import type { PipedProcessSpec } from '@orca/process-host/process-spec'
import {
  forceTerminateProcessTree,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  isInitializeRequest,
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ResultSchema,
  type JSONRPCRequest,
  type Result,
  type ServerNotification,
  type ServerRequest
} from '@modelcontextprotocol/sdk/types.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { ChildStdioMcpTransport, logChildStderr } from './child-stdio-mcp-transport'
import { answerNoSession, answerSessionGone, cut } from './shared-mcp-http-answers'
import { SharedMcpResourceSubscriptions } from './shared-mcp-resource-subscriptions'

/** What starts the child: an absolute program, its args and env, run in the user's home. */
export type SharedMcpLaunch = {
  program: string
  args: readonly string[]
  env: Record<string, string>
  cwd: string
}

// `npx -y` fetches the package on its first run.
const START_TIMEOUT_MS = 120_000
// Each agent keeps its own (shorter) limit; this only stops a call nobody is waiting on any more.
const CALL_TIMEOUT_MS = 30 * 60_000
/** An agent that keeps no event stream open counts as gone after this long without a request. */
const SESSION_IDLE_MS = 15 * 60_000
/** An agent whose event stream closed (it exited) counts as gone unless it reopens one by then. */
const STREAM_GONE_MS = 30_000
const MAX_SESSIONS = 256
const STOP_GRACE_MS = 2_000

type AgentSession = {
  server: Server
  transport: StreamableHTTPServerTransport
  /** Requests of this session whose response is still open (an event stream, a streamed reply). */
  open: number
  /** It opened an event stream, so its closing means the agent left. */
  streamed: boolean
  expiry: NodeJS.Timeout | undefined
}

/** The child couldn't be started, or didn't answer initialize. */
export class SharedMcpStartFailed extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : String(reason))
  }
}

export class SharedMcpProcess {
  /** Settles once the child answered initialize; rejects when it couldn't start. */
  readonly ready: Promise<void>
  private readonly client = new Client({ name: 'orca', version: '1.0.0' }, { capabilities: {} })
  private readonly sessions = new Map<string, AgentSession>()
  private readonly subscriptions = new SharedMcpResourceSubscriptions()
  private child: ChildProcessWithoutNullStreams | null = null
  /** Settles once its child has exited, or at once if it never started one. */
  exited: Promise<void> = Promise.resolve()
  /** Initializes waiting for the child; it isn't stopped as unused while one waits. */
  private waiting = 0
  private stopped = false

  constructor(
    readonly name: string,
    /** The command, args and env it was started with; a change starts a new one. */
    readonly fingerprint: string,
    prepare: () => Promise<SharedMcpLaunch>,
    /** Once, when it stops for any reason, so its owner forgets it. */
    private readonly onStopped: (process: SharedMcpProcess) => void,
    private readonly spawn: (
      spec: PipedProcessSpec
    ) => ChildProcessWithoutNullStreams = spawnProcess
  ) {
    this.client.fallbackNotificationHandler = async (notification) => {
      // List changes and log lines go to every agent using it, a log line only to those whose
      // `logging/setLevel` lets it through; a resource's update only to the sessions subscribed to it.
      const log = LoggingMessageNotificationSchema.safeParse(notification)
      const updated = ResourceUpdatedNotificationSchema.safeParse(notification)
      const to = updated.success ? this.subscriptions.subscribers(updated.data.params.uri) : null
      for (const [id, session] of this.sessions) {
        if (to && !to.has(id)) {
          continue
        }
        const sent = log.success
          ? session.server.sendLoggingMessage(log.data.params, id)
          : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the child is an MCP server, so what it notifies is a server notification; it goes on unchanged.
            session.server.notification(notification as ServerNotification)
        void sent.catch(() => {})
      }
    }
    this.client.onclose = () => this.stop()
    this.ready = this.start(prepare)
    this.ready.catch(() => this.stop())
  }

  /**
   * One agent request; `body` is the parsed POST body. An unknown session id gets 404, so its agent
   * starts over. False when it stopped while an initialize waited, unanswered, for a new one.
   */
  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<boolean> {
    const sessionId = req.headers['mcp-session-id']
    if (typeof sessionId === 'string') {
      const session = this.sessions.get(sessionId)
      if (session) {
        await this.serve(session, req, res, body)
      } else {
        answerSessionGone(res)
      }
      return true
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      answerNoSession(res)
      return true
    }
    // Held until its session is in, so the last other session ending meanwhile can't stop the child.
    this.waiting += 1
    try {
      try {
        await this.ready
      } catch (error) {
        throw new SharedMcpStartFailed(error)
      }
      if (this.stopped) {
        return false
      }
      // An agent that gave up while the child started opens no session.
      if (!cut(res)) {
        const session = await this.open()
        await this.serve(session, req, res, body)
        if (session.transport.sessionId === undefined) {
          // The initialize was refused, so no session started.
          void session.server.close()
        }
      }
      return true
    } finally {
      this.waiting -= 1
      this.stopIfUnused()
    }
  }

  /** Ends every agent's session and the child; `now` kills it at once (Orca is quitting). */
  stop(now = false): void {
    if (this.stopped) {
      if (now && this.child) {
        void signalProcessTree(this.child, 'SIGKILL')
      }
      return
    }
    this.stopped = true
    for (const session of this.sessions.values()) {
      clearTimeout(session.expiry)
      void session.server.close()
    }
    this.sessions.clear()
    void this.client.close()
    // The whole tree, even once the root exited: a wrapper such as `npx` can leave its server behind.
    const child = this.child
    if (child) {
      void signalProcessTree(child, now ? 'SIGKILL' : 'SIGTERM')
      if (!now) {
        setTimeout(() => void forceTerminateProcessTree(child), STOP_GRACE_MS).unref()
      }
    }
    this.onStopped(this)
  }

  private async start(prepare: () => Promise<SharedMcpLaunch>): Promise<void> {
    const launch = await prepare()
    if (this.stopped) {
      throw new Error('stopped before it started')
    }
    const child = this.spawn({
      program: launch.program,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      stdio: 'pipe',
      // Its own process group on POSIX, so stopping it takes `npx`'s children too.
      detached: process.platform !== 'win32',
      timeoutMs: null
    })
    this.child = child
    this.exited = new Promise((resolve) => child.once('close', () => resolve()))
    logChildStderr(this.name, child)
    child.once('error', (error) => {
      console.warn(`[mcp-servers] ${this.name}'s shared process failed to start`, error)
    })
    child.once('exit', (code, signal) => {
      if (!this.stopped) {
        console.warn(`[mcp-servers] ${this.name}'s shared process exited (${signal ?? code})`)
        this.stop()
      }
    })
    await this.client.connect(new ChildStdioMcpTransport(child), { timeout: START_TIMEOUT_MS })
  }

  private async open(): Promise<AgentSession> {
    const server = new Server(this.client.getServerVersion() ?? { name: this.name, version: '0' }, {
      capabilities: this.client.getServerCapabilities() ?? {},
      ...(this.client.getInstructions() ? { instructions: this.client.getInstructions() } : {})
    })
    const session: AgentSession = {
      server,
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          this.sessions.set(id, session)
          this.evictOverCap()
        }
      }),
      open: 0,
      streamed: false,
      expiry: undefined
    }
    server.fallbackRequestHandler = (request, extra) => this.forward(session, request, extra)
    server.onclose = () => this.ended(session)
    await server.connect(session.transport)
    return session
  }

  private async serve(
    session: AgentSession,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown
  ): Promise<void> {
    if (cut(res)) {
      // Its agent hung up, or its token was revoked, before Orca got to it.
      this.expireWhenIdle(session)
      return
    }
    session.open += 1
    clearTimeout(session.expiry)
    if (req.method === 'GET') {
      session.streamed = true
    }
    res.once('close', () => {
      session.open -= 1
      this.expireWhenIdle(session)
    })
    await session.transport.handleRequest(req, res, body)
    // Held until the reply or event stream ends, so the relay counts it as open meanwhile.
    if (!res.writableFinished && !res.destroyed) {
      await once(res, 'close')
    }
  }

  /** A session with nothing open ends after a while unless its agent comes back. */
  private expireWhenIdle(session: AgentSession): void {
    if (session.open > 0 || this.stopped) {
      return
    }
    clearTimeout(session.expiry)
    session.expiry = setTimeout(
      () => void session.server.close(),
      session.streamed ? STREAM_GONE_MS : SESSION_IDLE_MS
    )
    session.expiry.unref()
  }

  private forward(
    session: AgentSession,
    request: JSONRPCRequest,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
  ): Promise<Result> {
    const send = () => this.send(session, request, extra)
    return this.subscriptions.forward(request, session.transport.sessionId ?? '', send) ?? send()
  }

  /** An agent's request, sent on to the child as Orca's own; its progress and cancel go along. */
  private send(
    session: AgentSession,
    { method, params }: JSONRPCRequest,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
  ): Promise<Result> {
    const token = params?._meta?.progressToken
    // A call its agent cancelled gets no reply, so its response stream ends here instead.
    const cancelled = (): void => session.transport.closeSSEStream(extra.requestId)
    extra.signal.addEventListener('abort', cancelled, { once: true })
    const reply = this.client.request({ method, ...(params ? { params } : {}) }, ResultSchema, {
      signal: extra.signal,
      timeout: CALL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
      ...(token === undefined
        ? {}
        : {
            onprogress: (progress) =>
              void extra
                .sendNotification({
                  method: 'notifications/progress',
                  params: { ...progress, progressToken: token }
                })
                .catch(() => {})
          })
    })
    return reply.finally(() => extra.signal.removeEventListener('abort', cancelled))
  }

  private ended(session: AgentSession): void {
    clearTimeout(session.expiry)
    const id = session.transport.sessionId
    if (id !== undefined && this.sessions.get(id) === session) {
      this.sessions.delete(id)
      for (const uri of this.subscriptions.release(id)) {
        void this.client
          .request({ method: 'resources/unsubscribe', params: { uri } }, ResultSchema)
          .catch(() => {})
      }
    }
    this.stopIfUnused()
  }

  /** The last agent's session ended: nothing else uses the child. */
  private stopIfUnused(): void {
    if (this.sessions.size === 0 && this.waiting === 0) {
      this.stop()
    }
  }

  /** Past the cap, the oldest sessions with nothing open end; their agents start over if they come back. */
  private evictOverCap(): void {
    let excess = this.sessions.size - MAX_SESSIONS
    for (const session of this.sessions.values()) {
      if (excess <= 0) {
        return
      }
      if (session.open === 0) {
        excess -= 1
        void session.server.close()
      }
    }
  }
}
