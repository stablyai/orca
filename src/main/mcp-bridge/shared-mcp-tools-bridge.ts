import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse
} from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  LOOPBACK_HOST,
  MCP_PATH,
  forwardMcpProgress,
  readJsonBody,
  sendJsonError,
  type SharedMcpStdioDefinition,
  type SharedMcpToolsBridgeConnection,
  type SharedMcpToolsBridgeOptions,
  type SharedMcpToolsBridgeStatus
} from './shared-mcp-tools-bridge-support'

type BridgeSession = {
  id: string | null
  server: Server
  transport: StreamableHTTPServerTransport
}

export class SharedMcpToolsBridge {
  private readonly definition: SharedMcpStdioDefinition
  private readonly idleTimeoutMs: number
  private readonly token: string
  private readonly sessions = new Map<string, BridgeSession>()
  private httpServer: HttpServer | null = null
  private connection: SharedMcpToolsBridgeConnection | null = null
  private downstreamClient: Client | null = null
  private downstreamTransport: StdioClientTransport | null = null
  private downstreamConnect: Promise<Client> | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private closing = false

  constructor(definition: SharedMcpStdioDefinition, options: SharedMcpToolsBridgeOptions = {}) {
    if (!definition.command.trim()) {
      throw new Error('Shared MCP stdio command is required')
    }
    this.definition = {
      command: definition.command,
      args: definition.args ? [...definition.args] : undefined,
      cwd: definition.cwd,
      env: definition.env ? { ...definition.env } : undefined,
      isolationKey: definition.isolationKey
    }
    this.idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? 30_000)
    this.token = options.token ?? randomBytes(32).toString('base64url')
  }

  async start(): Promise<SharedMcpToolsBridgeConnection> {
    if (this.connection) {
      return this.connection
    }
    if (this.closing) {
      throw new Error('Shared MCP bridge is closing')
    }
    const server = createServer((request, response) => {
      void this.handleHttpRequest(request, response).catch(() => {
        sendJsonError(response, 500, 'MCP bridge request failed')
      })
    })
    this.httpServer = server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      server.once('error', onError)
      server.listen(0, LOOPBACK_HOST, () => {
        server.off('error', onError)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    this.connection = {
      url: new URL(`http://${LOOPBACK_HOST}:${address.port}${MCP_PATH}`),
      headers: Object.freeze({ authorization: `Bearer ${this.token}` })
    }
    return this.connection
  }

  getStatus(): SharedMcpToolsBridgeStatus {
    return {
      downstreamPid: this.downstreamTransport?.pid ?? null,
      sessionCount: this.sessions.size
    }
  }

  private isAuthorized(request: IncomingMessage): boolean {
    return request.headers.authorization === `Bearer ${this.token}`
  }

  private hasAllowedHost(request: IncomingMessage): boolean {
    if (!this.connection) {
      return false
    }
    const expected = `${LOOPBACK_HOST}:${this.connection.url.port}`
    return request.headers.host === expected
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (!this.connection || request.url !== MCP_PATH || !this.hasAllowedHost(request)) {
      sendJsonError(response, 404, 'Not found')
      return
    }
    if (!this.isAuthorized(request)) {
      response.setHeader('www-authenticate', 'Bearer')
      sendJsonError(response, 401, 'Unauthorized')
      return
    }
    if (!['GET', 'POST', 'DELETE'].includes(request.method ?? '')) {
      response.setHeader('allow', 'GET, POST, DELETE')
      sendJsonError(response, 405, 'Method not allowed')
      return
    }

    const sessionId = request.headers['mcp-session-id']
    if (typeof sessionId === 'string') {
      const session = this.sessions.get(sessionId)
      if (!session) {
        sendJsonError(response, 404, 'Unknown MCP session')
        return
      }
      const body = request.method === 'POST' ? await readJsonBody(request) : undefined
      await session.transport.handleRequest(request, response, body)
      return
    }

    if (request.method !== 'POST') {
      sendJsonError(response, 400, 'MCP session id is required')
      return
    }
    const body = await readJsonBody(request)
    if (!isInitializeRequest(body)) {
      sendJsonError(response, 400, 'Initialize request is required')
      return
    }
    const session = await this.createSession()
    await session.transport.handleRequest(request, response, body)
  }

  private async createSession(): Promise<BridgeSession> {
    const downstream = await this.ensureDownstreamClient()
    const capabilities = downstream.getServerCapabilities()
    if (!capabilities?.tools) {
      this.scheduleIdleShutdown()
      throw new Error('Shared MCP bridge currently supports tools-capable servers only')
    }
    this.cancelIdleShutdown()

    const server = new Server(
      { name: 'orca-shared-mcp-tools-bridge', version: '0.1.0' },
      { capabilities: { tools: { listChanged: capabilities.tools.listChanged === true } } }
    )
    const session: BridgeSession = {
      id: null,
      server,
      transport: null as unknown as StreamableHTTPServerTransport
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        session.id = id
        this.sessions.set(id, session)
      },
      onsessionclosed: (id) => this.removeSession(id)
    })
    session.transport = transport
    server.setRequestHandler(ListToolsRequestSchema, (request) =>
      this.withDownstreamClient((client) => client.listTools(request.params))
    )
    server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
      this.withDownstreamClient((client) =>
        client.callTool(request.params, undefined, {
          signal: extra.signal,
          onprogress: (progress) =>
            forwardMcpProgress(progress, extra._meta?.progressToken, extra.sendNotification)
        })
      )
    )
    server.onclose = () => {
      if (session.id) {
        this.removeSession(session.id)
      }
    }
    await server.connect(transport)
    return session
  }

  private async withDownstreamClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.ensureDownstreamClient()
    return operation(client)
  }

  private async ensureDownstreamClient(): Promise<Client> {
    if (this.downstreamClient) {
      return this.downstreamClient
    }
    if (this.downstreamConnect) {
      return this.downstreamConnect
    }
    this.cancelIdleShutdown()
    const connecting = this.connectDownstream()
    this.downstreamConnect = connecting
    try {
      return await connecting
    } finally {
      if (this.downstreamConnect === connecting) {
        this.downstreamConnect = null
      }
    }
  }

  private async connectDownstream(): Promise<Client> {
    const transport = new StdioClientTransport({
      command: this.definition.command,
      args: this.definition.args,
      cwd: this.definition.cwd,
      env: this.definition.env,
      stderr: 'ignore'
    })
    const client = new Client(
      { name: 'orca-shared-mcp-tools-bridge', version: '0.1.0' },
      {
        capabilities: {},
        listChanged: {
          tools: { onChanged: () => this.broadcastToolListChanged() }
        }
      }
    )
    client.onclose = () => {
      if (this.downstreamClient === client) {
        this.downstreamClient = null
        this.downstreamTransport = null
      }
    }
    await client.connect(transport)
    this.downstreamClient = client
    this.downstreamTransport = transport
    return client
  }

  private broadcastToolListChanged(): void {
    for (const session of this.sessions.values()) {
      void session.server.sendToolListChanged().catch(() => undefined)
    }
  }

  private removeSession(id: string): void {
    if (!this.sessions.delete(id) || this.sessions.size > 0) {
      return
    }
    this.scheduleIdleShutdown()
  }

  private scheduleIdleShutdown(): void {
    this.cancelIdleShutdown()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void this.closeDownstream()
    }, this.idleTimeoutMs)
    this.idleTimer.unref?.()
  }

  private cancelIdleShutdown(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private async closeDownstream(): Promise<void> {
    const client = this.downstreamClient
    this.downstreamClient = null
    this.downstreamTransport = null
    if (client) {
      await client.close().catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    if (this.closing) {
      return
    }
    this.closing = true
    this.cancelIdleShutdown()
    const sessionServers = [...this.sessions.values()].map((session) => session.server)
    this.sessions.clear()
    await Promise.allSettled(sessionServers.map((server) => server.close()))
    await this.closeDownstream()
    const server = this.httpServer
    this.httpServer = null
    this.connection = null
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
