// `orca mcp connect`'s stdio side: the agent starts it as an MCP server and it becomes the host's
// server (its HTTP address, through Orca's relay when Orca holds the sign-in, or its command). A
// server that's off for the session answers as one with no tools and stays up, so the agent never
// shows it failing. Each message is forwarded as it arrives: the agent's stdio may cross WSL interop.
import type { McpServerConnection } from '../../shared/mcp-servers/mcp-servers'
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { spawnProcess } from '@orca/process-host'

type Connect = () => Promise<McpServerConnection>
type HttpConnection = Extract<McpServerConnection, { url: string }>

/** A replayed handshake that gets no answer fails the message instead of holding every later one. */
const HANDSHAKE_TIMEOUT_MS = 30_000
const RECONNECT_ID = 'orca-reconnect-'

const stdinEnded = (): Promise<void> =>
  new Promise((resolve) => {
    process.stdin.once('end', resolve)
    process.stdin.once('close', resolve)
  })

/** Bridges until the agent closes stdin (or the command ends); resolves to the exit code. */
export async function bridgeMcpServer(connect: Connect, version: string): Promise<number> {
  const connection = await connect()
  if (!connection.on) {
    await serveNoTools(version)
    return 0
  }
  if ('command' in connection) {
    return await runCommand(connection)
  }
  const bridge = new HttpBridge(new StdioServerTransport(), connection, connect)
  await bridge.run()
  return 0
}

async function serveNoTools(version: string): Promise<void> {
  const server = new Server({ name: 'orca', version }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }))
  const ended = stdinEnded()
  await server.connect(new StdioServerTransport())
  await ended
  await server.close()
}

/** The command takes the agent's stdio itself; the bridge only waits for it and passes signals on. */
async function runCommand(
  connection: Extract<McpServerConnection, { command: string }>
): Promise<number> {
  const child = spawnProcess({
    program: connection.command,
    args: connection.args,
    cwd: process.cwd(),
    env: { ...process.env, ...connection.env },
    stdio: 'inherit'
  })
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal)
  process.on('SIGINT', forward('SIGINT'))
  process.on('SIGTERM', forward('SIGTERM'))
  return await new Promise<number>((resolve) => {
    child.once('error', (error) => {
      process.stderr.write(
        `orca mcp connect: couldn't start ${connection.command}: ${error.message}\n`
      )
      resolve(1)
    })
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

/**
 * The server never ran the message: nothing listened (Orca restarted, so its relay moved), or it
 * refused the token or session before running anything.
 */
function neverReachedServer(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) {
    return error.code === 401 || error.code === 403 || error.code === 404
  }
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined
  return cause?.code === 'ECONNREFUSED'
}

const isRequest = (
  message: JSONRPCMessage
): message is JSONRPCMessage & {
  id: string | number
  method: string
} => 'method' in message && 'id' in message
const isInitialize = (message: JSONRPCMessage): boolean =>
  isRequest(message) && message.method === 'initialize'
const isInitialized = (message: JSONRPCMessage): boolean =>
  'method' in message && !('id' in message) && message.method === 'notifications/initialized'

/**
 * stdio to a Streamable HTTP server. When a send fails (Orca restarted, so its relay moved and its
 * token changed, or the server dropped the session), it asks the host again, replays the agent's
 * handshake on a fresh session and sends the message once more.
 */
class HttpBridge {
  private upstream: StreamableHTTPClientTransport | null = null
  private generation = 0
  private reopening: Promise<void> | null = null
  private handshake: Promise<void> = Promise.resolve()
  private initialize: (JSONRPCMessage & { id: string | number }) | null = null
  private initialized = false
  private readonly replies = new Map<string | number, (message: JSONRPCMessage) => void>()

  constructor(
    private readonly stdio: StdioServerTransport,
    private readonly first: HttpConnection,
    private readonly connect: Connect
  ) {}

  async run(): Promise<void> {
    this.install(await this.create(this.first))
    const ended = stdinEnded()
    this.stdio.onmessage = (message) => {
      // The handshake goes in order; everything after it goes as it comes, so a long call never
      // holds up a cancellation.
      if (isInitialize(message) || isInitialized(message)) {
        this.handshake = this.handshake.then(() => this.forward(message))
      } else {
        void this.handshake.then(() => this.forward(message))
      }
    }
    await this.stdio.start()
    await ended
    const upstream = this.upstream
    await upstream?.terminateSession().catch(() => {})
    await upstream?.close().catch(() => {})
    await this.stdio.close()
  }

  private async create(connection: HttpConnection): Promise<StreamableHTTPClientTransport> {
    const upstream = new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: connection.headers }
    })
    upstream.onmessage = (message) => this.fromServer(upstream, message)
    // A dropped notification stream reconnects by itself; a failed send is handled where it's made.
    upstream.onerror = () => {}
    await upstream.start()
    return upstream
  }

  /** Messages go to `upstream` from now on; only a session whose handshake is done gets here. */
  private install(upstream: StreamableHTTPClientTransport): void {
    const previous = this.upstream
    this.upstream = upstream
    this.generation += 1
    void previous?.close().catch(() => {})
  }

  private fromServer(upstream: StreamableHTTPClientTransport, message: JSONRPCMessage): void {
    const id = 'id' in message ? message.id : undefined
    const answer = id !== undefined && !('method' in message)
    const reply = answer ? this.replies.get(id) : undefined
    if (reply) {
      this.replies.delete(id!)
      reply(message)
      return
    }
    if (answer && typeof id === 'string' && id.startsWith(RECONNECT_ID)) {
      // A replayed handshake's answer after it timed out: the agent never sent that id.
      return
    }
    const version =
      'result' in message && id === this.initialize?.id ? message.result.protocolVersion : undefined
    if (typeof version === 'string') {
      upstream.setProtocolVersion(version)
    }
    void this.stdio.send(message).catch(() => {})
  }

  private async forward(message: JSONRPCMessage): Promise<void> {
    if (isInitialize(message) && isRequest(message)) {
      this.initialize = message
    }
    if (isInitialized(message)) {
      this.initialized = true
    }
    // A message that comes in while the session is being replaced waits for the new one.
    await this.reopening?.catch(() => {})
    const sentOn = this.generation
    try {
      await this.upstream!.send(message)
      return
    } catch (error) {
      // Sent again only when the server provably never ran it: a call cut off mid-answer may have
      // done its work, and running it twice could do it twice.
      if (!neverReachedServer(error)) {
        this.fail(message, error)
        return
      }
    }
    try {
      if (this.generation === sentOn) {
        this.reopening ??= this.reopen(message).finally(() => {
          this.reopening = null
        })
      }
      await this.reopening
      await this.upstream!.send(message)
    } catch (error) {
      this.fail(message, error)
    }
  }

  private fail(message: JSONRPCMessage, error: unknown): void {
    if (isRequest(message)) {
      const reason = error instanceof Error ? error.message : String(error)
      void this.stdio
        .send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: reason } })
        .catch(() => {})
    }
  }

  private async reopen(failed: JSONRPCMessage): Promise<void> {
    const connection = await this.connect()
    if (!connection.on || !('url' in connection)) {
      throw new Error('This server is no longer on for this session.')
    }
    const upstream = await this.create(connection)
    try {
      if (this.initialize && failed !== this.initialize) {
        await this.replayHandshake(upstream, this.initialize)
      }
    } catch (error) {
      // The old session stays in place, so the next message fails the same way and tries again.
      await upstream.close().catch(() => {})
      throw error
    }
    this.install(upstream)
  }

  /** The agent's own handshake, again on the new session; its answer stays here. */
  private async replayHandshake(
    upstream: StreamableHTTPClientTransport,
    handshake: JSONRPCMessage & { id: string | number }
  ): Promise<void> {
    const id = `${RECONNECT_ID}${this.generation + 1}`
    let timer: ReturnType<typeof setTimeout> | undefined
    const answered = new Promise<JSONRPCMessage>((resolve, reject) => {
      this.replies.set(id, resolve)
      timer = setTimeout(
        () => reject(new Error('The server didn’t answer after Orca restarted.')),
        HANDSHAKE_TIMEOUT_MS
      )
    })
    let answer: JSONRPCMessage
    try {
      await upstream.send({ ...handshake, id })
      answer = await answered
    } finally {
      clearTimeout(timer)
      this.replies.delete(id)
    }
    const version = 'result' in answer ? answer.result.protocolVersion : undefined
    if (typeof version === 'string') {
      upstream.setProtocolVersion(version)
    }
    if (this.initialized) {
      await upstream.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    }
  }
}
