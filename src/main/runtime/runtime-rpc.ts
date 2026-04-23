/* eslint-disable max-lines -- Why: the local RPC server is a single security boundary for the bundled CLI, so transport validation and method routing are intentionally reviewed together. */
import { randomBytes } from 'crypto'
import { createServer, type Server, type Socket } from 'net'
import { chmodSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import type { RuntimeMetadata, RuntimeTransportMetadata } from '../../shared/runtime-bootstrap'
import type { OrcaRuntimeService } from './orca-runtime'
import { writeRuntimeMetadata } from './runtime-metadata'

type RuntimeRpcRequest = {
  id: string
  authToken: string
  method: string
  params?: unknown
}

type RuntimeRpcResponse =
  | {
      id: string
      ok: true
      result: unknown
      _meta: {
        runtimeId: string
      }
    }
  | {
      id: string
      ok: false
      error: {
        code: string
        message: string
        data?: unknown
      }
      _meta: {
        runtimeId: string
      }
    }

type OrcaRuntimeRpcServerOptions = {
  runtime: OrcaRuntimeService
  userDataPath: string
  pid?: number
  platform?: NodeJS.Platform
}

const MAX_RUNTIME_RPC_MESSAGE_BYTES = 1024 * 1024
const RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS = 30_000
const MAX_RUNTIME_RPC_CONNECTIONS = 32

export class OrcaRuntimeRpcServer {
  private readonly runtime: OrcaRuntimeService
  private readonly userDataPath: string
  private readonly pid: number
  private readonly platform: NodeJS.Platform
  private readonly authToken = randomBytes(24).toString('hex')
  private server: Server | null = null
  private transport: RuntimeTransportMetadata | null = null

  constructor({
    runtime,
    userDataPath,
    pid = process.pid,
    platform = process.platform
  }: OrcaRuntimeRpcServerOptions) {
    this.runtime = runtime
    this.userDataPath = userDataPath
    this.pid = pid
    this.platform = platform
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }

    const transport = createRuntimeTransportMetadata(
      this.userDataPath,
      this.pid,
      this.platform,
      this.runtime.getRuntimeId()
    )
    if (transport.kind === 'unix' && existsSync(transport.endpoint)) {
      rmSync(transport.endpoint, { force: true })
    }

    const server = createServer((socket) => {
      this.handleConnection(socket)
    })
    server.maxConnections = MAX_RUNTIME_RPC_CONNECTIONS

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(transport.endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (transport.kind === 'unix') {
      chmodSync(transport.endpoint, 0o600)
    }

    // Why: publish the transport into in-memory state before writing metadata
    // so the bootstrap file always contains the real endpoint/token pair. The
    // CLI only discovers the runtime through that file.
    this.server = server
    this.transport = transport

    try {
      this.writeMetadata()
    } catch (error) {
      // Why: a runtime that cannot publish bootstrap metadata is invisible to
      // the `orca` CLI. Close the socket immediately instead of leaving behind
      // a live but undiscoverable control plane.
      this.server = null
      this.transport = null
      await new Promise<void>((resolve, reject) => {
        server.close((closeError) => {
          if (closeError) {
            reject(closeError)
            return
          }
          resolve()
        })
      }).catch(() => {})
      if (transport.kind === 'unix' && existsSync(transport.endpoint)) {
        rmSync(transport.endpoint, { force: true })
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    const transport = this.transport
    this.server = null
    this.transport = null
    if (!server) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    if (transport?.kind === 'unix' && existsSync(transport.endpoint)) {
      rmSync(transport.endpoint, { force: true })
    }
    // Why: we intentionally leave the last metadata file behind instead of
    // deleting it on shutdown. Shared userData paths can briefly host multiple
    // Orca processes during restarts, updates, or development, and stale
    // metadata is safer than letting one process erase another live runtime's
    // bootstrap file.
  }

  private handleConnection(socket: Socket): void {
    let buffer = ''

    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.setTimeout(RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS, () => {
      socket.destroy()
    })
    socket.on('error', () => {
      socket.destroy()
    })
    socket.on('data', (chunk: string) => {
      buffer += chunk
      // Why: the Orca runtime lives in Electron main, so it must reject
      // oversized local RPC frames instead of letting a local client grow an
      // unbounded buffer and stall the app.
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RUNTIME_RPC_MESSAGE_BYTES) {
        socket.write(
          `${JSON.stringify(this.errorResponse('unknown', 'request_too_large', 'RPC request exceeds the maximum size'))}\n`
        )
        socket.end()
        return
      }
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const rawMessage = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (rawMessage) {
          void this.handleMessage(rawMessage).then((response) => {
            socket.write(`${JSON.stringify(response)}\n`)
          })
        }
        newlineIndex = buffer.indexOf('\n')
      }
    })
  }

  private async handleMessage(rawMessage: string): Promise<RuntimeRpcResponse> {
    let request: RuntimeRpcRequest
    try {
      request = JSON.parse(rawMessage) as RuntimeRpcRequest
    } catch {
      return this.errorResponse('unknown', 'bad_request', 'Invalid JSON request')
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      return this.errorResponse('unknown', 'bad_request', 'Missing request id')
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      return this.errorResponse(request.id, 'bad_request', 'Missing RPC method')
    }
    if (typeof request.authToken !== 'string' || request.authToken.length === 0) {
      return this.errorResponse(request.id, 'unauthorized', 'Missing auth token')
    }

    if (request.authToken !== this.authToken) {
      return this.errorResponse(request.id, 'unauthorized', 'Invalid auth token')
    }

    if (request.method === 'status.get') {
      return {
        id: request.id,
        ok: true,
        result: this.runtime.getStatus(),
        _meta: {
          runtimeId: this.runtime.getRuntimeId()
        }
      }
    }

    if (request.method === 'terminal.list') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { worktree?: unknown; limit?: unknown })
            : null
        const worktreeSelector = params?.worktree ?? null

        const result = await this.runtime.listTerminals(
          typeof worktreeSelector === 'string' ? worktreeSelector : undefined,
          typeof params?.limit === 'number' && Number.isFinite(params.limit)
            ? params.limit
            : undefined
        )

        return {
          id: request.id,
          ok: true,
          result,
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'terminal.resolveActive') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { worktree?: unknown })
            : null
        const worktree = typeof params?.worktree === 'string' ? params.worktree : undefined
        const handle = await this.runtime.resolveActiveTerminal(worktree)
        return {
          id: request.id,
          ok: true,
          result: { handle },
          _meta: { runtimeId: this.runtime.getRuntimeId() }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'terminal.show') {
      try {
        const terminalHandle =
          request.params && typeof request.params === 'object' && request.params !== null
            ? ((request.params as { terminal?: unknown }).terminal ?? null)
            : null

        if (typeof terminalHandle !== 'string' || terminalHandle.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing terminal handle')
        }

        const result = await this.runtime.showTerminal(terminalHandle)
        return {
          id: request.id,
          ok: true,
          result: { terminal: result },
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'terminal.read') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { terminal?: unknown; cursor?: unknown })
            : null

        const terminalHandle = params?.terminal ?? null
        if (typeof terminalHandle !== 'string' || terminalHandle.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing terminal handle')
        }

        if (
          params?.cursor !== undefined &&
          (!Number.isInteger(params.cursor) || (params.cursor as number) < 0)
        ) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Cursor must be a non-negative integer'
          )
        }

        const cursor =
          typeof params?.cursor === 'number' && Number.isFinite(params.cursor)
            ? params.cursor
            : undefined

        const result = await this.runtime.readTerminal(terminalHandle, { cursor })
        return {
          id: request.id,
          ok: true,
          result: { terminal: result },
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'terminal.rename') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { terminal?: unknown; title?: unknown })
            : null
        const terminalHandle = params?.terminal ?? null
        if (typeof terminalHandle !== 'string' || terminalHandle.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing terminal handle')
        }
        const title =
          params?.title === null
            ? null
            : typeof params?.title === 'string'
              ? params.title
              : undefined
        if (title === undefined) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing --title (pass empty string or null to reset)'
          )
        }
        const result = await this.runtime.renameTerminal(terminalHandle, title || null)
        return {
          id: request.id,
          ok: true,
          result: { rename: result },
          _meta: { runtimeId: this.runtime.getRuntimeId() }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'terminal.send') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as {
                terminal?: unknown
                text?: unknown
                enter?: unknown
                interrupt?: unknown
              })
            : null

        const terminalHandle = params?.terminal ?? null
        if (typeof terminalHandle !== 'string' || terminalHandle.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing terminal handle')
        }

        const result = await this.runtime.sendTerminal(terminalHandle, {
          text: typeof params?.text === 'string' ? params.text : undefined,
          enter: params?.enter === true,
          interrupt: params?.interrupt === true
        })
        return {
          id: request.id,
          ok: true,
          result: { send: result },
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'terminal.wait') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as {
                terminal?: unknown
                for?: unknown
                timeoutMs?: unknown
              })
            : null

        const terminalHandle = params?.terminal ?? null
        if (typeof terminalHandle !== 'string' || terminalHandle.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing terminal handle')
        }

        const forCondition = params?.for
        if (forCondition !== 'exit' && forCondition !== 'tui-idle') {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Invalid --for value. Supported: exit, tui-idle'
          )
        }

        const timeoutMs =
          typeof params?.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
            ? params.timeoutMs
            : undefined

        const result = await this.runtime.waitForTerminal(terminalHandle, {
          condition: forCondition,
          timeoutMs
        })
        return {
          id: request.id,
          ok: true,
          result: { wait: result },
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'worktree.ps') {
      try {
        const limit =
          request.params && typeof request.params === 'object' && request.params !== null
            ? ((request.params as { limit?: unknown }).limit ?? null)
            : null
        const result = await this.runtime.getWorktreePs(
          typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined
        )
        return {
          id: request.id,
          ok: true,
          result,
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'repo.list') {
      return {
        id: request.id,
        ok: true,
        result: { repos: this.runtime.listRepos() },
        _meta: {
          runtimeId: this.runtime.getRuntimeId()
        }
      }
    }

    if (request.method === 'repo.add') {
      try {
        const pathValue =
          request.params && typeof request.params === 'object' && request.params !== null
            ? ((request.params as { path?: unknown }).path ?? null)
            : null
        if (typeof pathValue !== 'string' || pathValue.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing repo path')
        }
        const result = await this.runtime.addRepo(pathValue)
        return {
          id: request.id,
          ok: true,
          result: { repo: result },
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'repo.show') {
      try {
        const selector =
          request.params && typeof request.params === 'object' && request.params !== null
            ? ((request.params as { repo?: unknown }).repo ?? null)
            : null
        if (typeof selector !== 'string' || selector.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing repo selector')
        }
        const result = await this.runtime.showRepo(selector)
        return {
          id: request.id,
          ok: true,
          result: { repo: result },
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'repo.setBaseRef') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { repo?: unknown; ref?: unknown })
            : null
        const selector = params?.repo
        const ref = params?.ref
        if (typeof selector !== 'string' || selector.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing repo selector')
        }
        if (typeof ref !== 'string' || ref.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing base ref')
        }
        const result = await this.runtime.setRepoBaseRef(selector, ref)
        return {
          id: request.id,
          ok: true,
          result: { repo: result },
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'repo.searchRefs') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { repo?: unknown; query?: unknown; limit?: unknown })
            : null
        const selector = params?.repo
        const query = params?.query
        if (typeof selector !== 'string' || selector.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing repo selector')
        }
        if (typeof query !== 'string') {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing query')
        }
        const result = await this.runtime.searchRepoRefs(
          selector,
          query,
          typeof params?.limit === 'number' ? params.limit : undefined
        )
        return {
          id: request.id,
          ok: true,
          result,
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'worktree.list') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { repo?: unknown; limit?: unknown })
            : null
        const repoSelector = params?.repo ?? null
        const result = await this.runtime.listManagedWorktrees(
          typeof repoSelector === 'string' ? repoSelector : undefined,
          typeof params?.limit === 'number' && Number.isFinite(params.limit)
            ? params.limit
            : undefined
        )
        return {
          id: request.id,
          ok: true,
          result,
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'worktree.show') {
      try {
        const selector =
          request.params && typeof request.params === 'object' && request.params !== null
            ? ((request.params as { worktree?: unknown }).worktree ?? null)
            : null
        if (typeof selector !== 'string' || selector.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing worktree selector')
        }
        const result = await this.runtime.showManagedWorktree(selector)
        return {
          id: request.id,
          ok: true,
          result: { worktree: result },
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'worktree.create') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as {
                repo?: unknown
                name?: unknown
                baseBranch?: unknown
                linkedIssue?: unknown
                comment?: unknown
              })
            : null
        const repoSelector = params?.repo
        const name = params?.name
        if (typeof repoSelector !== 'string' || repoSelector.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing repo selector')
        }
        if (typeof name !== 'string' || name.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing worktree name')
        }
        const result = await this.runtime.createManagedWorktree({
          repoSelector,
          name,
          baseBranch: typeof params?.baseBranch === 'string' ? params.baseBranch : undefined,
          linkedIssue:
            typeof params?.linkedIssue === 'number'
              ? params.linkedIssue
              : params?.linkedIssue === null
                ? null
                : undefined,
          comment: typeof params?.comment === 'string' ? params.comment : undefined
        })
        return {
          id: request.id,
          ok: true,
          result,
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'worktree.set') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as {
                worktree?: unknown
                displayName?: unknown
                linkedIssue?: unknown
                comment?: unknown
              })
            : null
        const selector = params?.worktree
        if (typeof selector !== 'string' || selector.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing worktree selector')
        }
        const result = await this.runtime.updateManagedWorktreeMeta(selector, {
          displayName: typeof params?.displayName === 'string' ? params.displayName : undefined,
          linkedIssue:
            typeof params?.linkedIssue === 'number'
              ? params.linkedIssue
              : params?.linkedIssue === null
                ? null
                : undefined,
          comment: typeof params?.comment === 'string' ? params.comment : undefined
        })
        return {
          id: request.id,
          ok: true,
          result: { worktree: result },
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'worktree.rm') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { worktree?: unknown; force?: unknown })
            : null
        const selector = params?.worktree
        if (typeof selector !== 'string' || selector.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing worktree selector')
        }
        await this.runtime.removeManagedWorktree(selector, params?.force === true)
        return {
          id: request.id,
          ok: true,
          result: { removed: true },
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'terminal.create') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { worktree?: unknown; command?: unknown; title?: unknown })
            : null
        const worktreeSelector =
          typeof params?.worktree === 'string' && params.worktree.length > 0
            ? params.worktree
            : undefined
        const result = await this.runtime.createTerminal(worktreeSelector, {
          command: typeof params?.command === 'string' ? params.command : undefined,
          title: typeof params?.title === 'string' ? params.title : undefined
        })
        return {
          id: request.id,
          ok: true,
          result: { terminal: result },
          _meta: { runtimeId: this.runtime.getRuntimeId() }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'terminal.split') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { terminal?: unknown; direction?: unknown; command?: unknown })
            : null
        const terminalHandle = params?.terminal
        if (typeof terminalHandle !== 'string' || terminalHandle.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing terminal handle')
        }
        const direction =
          params?.direction === 'vertical' || params?.direction === 'horizontal'
            ? params.direction
            : undefined
        const result = await this.runtime.splitTerminal(terminalHandle, {
          direction,
          command: typeof params?.command === 'string' ? params.command : undefined
        })
        return {
          id: request.id,
          ok: true,
          result: { split: result },
          _meta: { runtimeId: this.runtime.getRuntimeId() }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'terminal.stop') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { worktree?: unknown })
            : null
        const selector = params?.worktree
        if (typeof selector !== 'string' || selector.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing worktree selector')
        }
        const result = await this.runtime.stopTerminalsForWorktree(selector)
        return {
          id: request.id,
          ok: true,
          result: result,
          _meta: {
            runtimeId: this.runtime.getRuntimeId()
          }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    // ── Browser automation routes ──
    // Why: all browser routes extract optional worktree param for worktree-scoped tab routing

    if (request.method === 'browser.snapshot') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserSnapshot(this.extractBrowserTarget(params))
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.click') {
      try {
        const params = this.extractParams(request)
        const element = typeof params?.element === 'string' ? params.element : null
        if (!element) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --element')
        }
        const result = await this.runtime.browserClick({
          element,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.goto') {
      try {
        const params = this.extractParams(request)
        const url = typeof params?.url === 'string' ? params.url : null
        if (!url) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --url')
        }
        const result = await this.runtime.browserGoto({ url, ...this.extractBrowserTarget(params) })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.fill') {
      try {
        const params = this.extractParams(request)
        const element = typeof params?.element === 'string' ? params.element : null
        const value = typeof params?.value === 'string' ? params.value : null
        if (!element) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --element')
        }
        if (value === null) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --value')
        }
        const result = await this.runtime.browserFill({
          element,
          value,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.type') {
      try {
        const params = this.extractParams(request)
        const input = typeof params?.input === 'string' ? params.input : null
        if (!input) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --input')
        }
        const result = await this.runtime.browserType({
          input,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.select') {
      try {
        const params = this.extractParams(request)
        const element = typeof params?.element === 'string' ? params.element : null
        const value = typeof params?.value === 'string' ? params.value : null
        if (!element) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --element')
        }
        if (value === null) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --value')
        }
        const result = await this.runtime.browserSelect({
          element,
          value,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.scroll') {
      try {
        const params = this.extractParams(request)
        const direction = typeof params?.direction === 'string' ? params.direction : null
        if (direction !== 'up' && direction !== 'down') {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing required --direction (up or down)'
          )
        }
        const amount =
          typeof params?.amount === 'number' && params.amount > 0 ? params.amount : undefined
        const result = await this.runtime.browserScroll({
          direction,
          amount,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.back') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserBack(this.extractBrowserTarget(params))
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.reload') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserReload(this.extractBrowserTarget(params))
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.screenshot') {
      try {
        const params = this.extractParams(request)
        const format =
          typeof params?.format === 'string' &&
          (params.format === 'png' || params.format === 'jpeg')
            ? params.format
            : undefined
        const result = await this.runtime.browserScreenshot({
          format,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.eval') {
      try {
        const params = this.extractParams(request)
        const expression = typeof params?.expression === 'string' ? params.expression : null
        if (!expression) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --expression')
        }
        const result = await this.runtime.browserEval({
          expression,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.tabList') {
      try {
        const params = this.extractParams(request)
        const worktree = typeof params?.worktree === 'string' ? params.worktree : undefined
        const result = await this.runtime.browserTabList({ worktree })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.tabSwitch') {
      try {
        const params = this.extractParams(request)
        const index = typeof params?.index === 'number' ? params.index : undefined
        const page =
          typeof params?.page === 'string' && params.page.length > 0 ? params.page : undefined
        if (page === undefined && (index === undefined || !Number.isInteger(index) || index < 0)) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing required --index (non-negative integer) or --page'
          )
        }
        const result = await this.runtime.browserTabSwitch({
          index,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.hover') {
      try {
        const params = this.extractParams(request)
        const element = typeof params?.element === 'string' ? params.element : null
        if (!element) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --element')
        }
        const result = await this.runtime.browserHover({
          element,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.drag') {
      try {
        const params = this.extractParams(request)
        const from = typeof params?.from === 'string' ? params.from : null
        const to = typeof params?.to === 'string' ? params.to : null
        if (!from || !to) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing required --from and --to element refs'
          )
        }
        const result = await this.runtime.browserDrag({
          from,
          to,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.upload') {
      try {
        const params = this.extractParams(request)
        const element = typeof params?.element === 'string' ? params.element : null
        const files = Array.isArray(params?.files) ? (params.files as string[]) : null
        if (!element || !files || files.length === 0) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing required --element and --files'
          )
        }
        const result = await this.runtime.browserUpload({
          element,
          files,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.wait') {
      try {
        const params = this.extractParams(request)
        const selector = typeof params?.selector === 'string' ? params.selector : undefined
        const raw = typeof params?.timeout === 'number' ? params.timeout : undefined
        const timeout = raw !== undefined && raw > 0 ? raw : undefined
        const text = typeof params?.text === 'string' ? params.text : undefined
        const url = typeof params?.url === 'string' ? params.url : undefined
        const load = typeof params?.load === 'string' ? params.load : undefined
        const fn = typeof params?.fn === 'string' ? params.fn : undefined
        const state = typeof params?.state === 'string' ? params.state : undefined
        const result = await this.runtime.browserWait({
          selector,
          timeout,
          text,
          url,
          load,
          fn,
          state,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.check') {
      try {
        const params = this.extractParams(request)
        const element = typeof params?.element === 'string' ? params.element : null
        const checked = params?.checked !== false
        if (!element) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --element')
        }
        const result = await this.runtime.browserCheck({
          element,
          checked,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.focus') {
      try {
        const params = this.extractParams(request)
        const element = typeof params?.element === 'string' ? params.element : null
        if (!element) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --element')
        }
        const result = await this.runtime.browserFocus({
          element,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.clear') {
      try {
        const params = this.extractParams(request)
        const element = typeof params?.element === 'string' ? params.element : null
        if (!element) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --element')
        }
        const result = await this.runtime.browserClear({
          element,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.selectAll') {
      try {
        const params = this.extractParams(request)
        const element = typeof params?.element === 'string' ? params.element : null
        if (!element) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --element')
        }
        const result = await this.runtime.browserSelectAll({
          element,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.keypress') {
      try {
        const params = this.extractParams(request)
        const key = typeof params?.key === 'string' ? params.key : null
        if (!key) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --key')
        }
        const result = await this.runtime.browserKeypress({
          key,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.pdf') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserPdf(this.extractBrowserTarget(params))
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.fullScreenshot') {
      try {
        const params = this.extractParams(request)
        const format = params?.format === 'jpeg' ? ('jpeg' as const) : ('png' as const)
        const result = await this.runtime.browserFullScreenshot({
          format,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Cookie management ──

    if (request.method === 'browser.cookie.get') {
      try {
        const params = this.extractParams(request)
        const url = typeof params?.url === 'string' ? params.url : undefined
        const result = await this.runtime.browserCookieGet({
          url,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.cookie.set') {
      try {
        const params = this.extractParams(request)
        const name = typeof params?.name === 'string' ? params.name : null
        const value = typeof params?.value === 'string' ? params.value : null
        if (!name || value === null) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing name or value')
        }
        const result = await this.runtime.browserCookieSet({
          name,
          value,
          domain: typeof params?.domain === 'string' ? params.domain : undefined,
          path: typeof params?.path === 'string' ? params.path : undefined,
          secure: typeof params?.secure === 'boolean' ? params.secure : undefined,
          httpOnly: typeof params?.httpOnly === 'boolean' ? params.httpOnly : undefined,
          sameSite: typeof params?.sameSite === 'string' ? params.sameSite : undefined,
          expires: typeof params?.expires === 'number' ? params.expires : undefined,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.cookie.delete') {
      try {
        const params = this.extractParams(request)
        const name = typeof params?.name === 'string' ? params.name : null
        if (!name) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing cookie name')
        }
        const result = await this.runtime.browserCookieDelete({
          name,
          domain: typeof params?.domain === 'string' ? params.domain : undefined,
          url: typeof params?.url === 'string' ? params.url : undefined,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Viewport emulation ──

    if (request.method === 'browser.viewport') {
      try {
        const params = this.extractParams(request)
        const width = typeof params?.width === 'number' ? params.width : null
        const height = typeof params?.height === 'number' ? params.height : null
        if (width === null || height === null || width <= 0 || height <= 0) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Width and height must be positive numbers'
          )
        }
        const result = await this.runtime.browserSetViewport({
          width,
          height,
          deviceScaleFactor:
            typeof params?.deviceScaleFactor === 'number' ? params.deviceScaleFactor : undefined,
          mobile: typeof params?.mobile === 'boolean' ? params.mobile : undefined,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Geolocation ──

    if (request.method === 'browser.geolocation') {
      try {
        const params = this.extractParams(request)
        const latitude = typeof params?.latitude === 'number' ? params.latitude : null
        const longitude = typeof params?.longitude === 'number' ? params.longitude : null
        if (latitude === null || longitude === null) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing latitude or longitude')
        }
        const result = await this.runtime.browserSetGeolocation({
          latitude,
          longitude,
          accuracy: typeof params?.accuracy === 'number' ? params.accuracy : undefined,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Request interception ──

    if (request.method === 'browser.intercept.enable') {
      try {
        const params = this.extractParams(request)
        const patterns = Array.isArray(params?.patterns) ? (params.patterns as string[]) : undefined
        const result = await this.runtime.browserInterceptEnable({
          patterns,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.intercept.disable') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserInterceptDisable(this.extractBrowserTarget(params))
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.intercept.list') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserInterceptList(this.extractBrowserTarget(params))
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Console/network capture ──

    if (request.method === 'browser.capture.start') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserCaptureStart(this.extractBrowserTarget(params))
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.capture.stop') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserCaptureStop(this.extractBrowserTarget(params))
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.console') {
      try {
        const params = this.extractParams(request)
        const limit = typeof params?.limit === 'number' ? params.limit : undefined
        const result = await this.runtime.browserConsoleLog({
          limit,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.network') {
      try {
        const params = this.extractParams(request)
        const limit = typeof params?.limit === 'number' ? params.limit : undefined
        const result = await this.runtime.browserNetworkLog({
          limit,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Additional core commands ──

    if (request.method === 'browser.dblclick') {
      try {
        const params = this.extractParams(request)
        const element = typeof params?.element === 'string' ? params.element : null
        if (!element) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --element')
        }
        const result = await this.runtime.browserDblclick({
          element,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.forward') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserForward(this.extractBrowserTarget(params))
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.scrollIntoView') {
      try {
        const params = this.extractParams(request)
        const element = typeof params?.element === 'string' ? params.element : null
        if (!element) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --element')
        }
        const result = await this.runtime.browserScrollIntoView({
          element,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.get') {
      try {
        const params = this.extractParams(request)
        const what = typeof params?.what === 'string' ? params.what : null
        if (!what) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --what')
        }
        const selector = typeof params?.selector === 'string' ? params.selector : undefined
        const result = await this.runtime.browserGet({
          what,
          selector,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.is') {
      try {
        const params = this.extractParams(request)
        const what = typeof params?.what === 'string' ? params.what : null
        const selector = typeof params?.selector === 'string' ? params.selector : null
        if (!what || !selector) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing required --what and --element'
          )
        }
        const result = await this.runtime.browserIs({
          what,
          selector,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Keyboard insert text ──

    if (request.method === 'browser.keyboardInsertText') {
      try {
        const params = this.extractParams(request)
        const text = typeof params?.text === 'string' ? params.text : null
        if (!text) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --text')
        }
        const result = await this.runtime.browserKeyboardInsertText({
          text,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Mouse commands ──

    if (request.method === 'browser.mouseMove') {
      try {
        const params = this.extractParams(request)
        const x = typeof params?.x === 'number' ? params.x : null
        const y = typeof params?.y === 'number' ? params.y : null
        if (x === null || y === null) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing required x and y coordinates'
          )
        }
        const result = await this.runtime.browserMouseMove({
          x,
          y,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.mouseDown') {
      try {
        const params = this.extractParams(request)
        const button = typeof params?.button === 'string' ? params.button : undefined
        const result = await this.runtime.browserMouseDown({
          button,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.mouseUp') {
      try {
        const params = this.extractParams(request)
        const button = typeof params?.button === 'string' ? params.button : undefined
        const result = await this.runtime.browserMouseUp({
          button,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.mouseWheel') {
      try {
        const params = this.extractParams(request)
        const dy = typeof params?.dy === 'number' ? params.dy : null
        if (dy === null) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --dy')
        }
        const dx = typeof params?.dx === 'number' ? params.dx : undefined
        const result = await this.runtime.browserMouseWheel({
          dy,
          dx,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Find (semantic locators) ──

    if (request.method === 'browser.find') {
      try {
        const params = this.extractParams(request)
        const locator = typeof params?.locator === 'string' ? params.locator : null
        const value = typeof params?.value === 'string' ? params.value : null
        const action = typeof params?.action === 'string' ? params.action : null
        if (!locator || !value || !action) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing required --locator, --value, and --action'
          )
        }
        const text = typeof params?.text === 'string' ? params.text : undefined
        const result = await this.runtime.browserFind({
          locator,
          value,
          action,
          text,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Set commands ──

    if (request.method === 'browser.setDevice') {
      try {
        const params = this.extractParams(request)
        const name = typeof params?.name === 'string' ? params.name : null
        if (!name) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --name')
        }
        const result = await this.runtime.browserSetDevice({
          name,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.setOffline') {
      try {
        const params = this.extractParams(request)
        const state = typeof params?.state === 'string' ? params.state : undefined
        const result = await this.runtime.browserSetOffline({
          state,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.setHeaders') {
      try {
        const params = this.extractParams(request)
        const headers = typeof params?.headers === 'string' ? params.headers : null
        if (!headers) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing required --headers (JSON string)'
          )
        }
        const result = await this.runtime.browserSetHeaders({
          headers,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.setCredentials') {
      try {
        const params = this.extractParams(request)
        const user = typeof params?.user === 'string' ? params.user : null
        const pass = typeof params?.pass === 'string' ? params.pass : null
        if (!user || pass === null) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing required --user and --pass'
          )
        }
        const result = await this.runtime.browserSetCredentials({
          user,
          pass,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.setMedia') {
      try {
        const params = this.extractParams(request)
        const colorScheme = typeof params?.colorScheme === 'string' ? params.colorScheme : undefined
        const reducedMotion =
          typeof params?.reducedMotion === 'string' ? params.reducedMotion : undefined
        const result = await this.runtime.browserSetMedia({
          colorScheme,
          reducedMotion,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Clipboard commands ──

    if (request.method === 'browser.clipboardRead') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserClipboardRead(this.extractBrowserTarget(params))
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.clipboardWrite') {
      try {
        const params = this.extractParams(request)
        const text = typeof params?.text === 'string' ? params.text : null
        if (!text) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --text')
        }
        const result = await this.runtime.browserClipboardWrite({
          text,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Dialog commands ──

    if (request.method === 'browser.dialogAccept') {
      try {
        const params = this.extractParams(request)
        const text = typeof params?.text === 'string' ? params.text : undefined
        const result = await this.runtime.browserDialogAccept({
          text,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.dialogDismiss') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserDialogDismiss(this.extractBrowserTarget(params))
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Storage commands ──

    if (request.method === 'browser.storage.local.get') {
      try {
        const params = this.extractParams(request)
        const key = typeof params?.key === 'string' ? params.key : null
        if (!key) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --key')
        }
        const result = await this.runtime.browserStorageLocalGet({
          key,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.storage.local.set') {
      try {
        const params = this.extractParams(request)
        const key = typeof params?.key === 'string' ? params.key : null
        const value = typeof params?.value === 'string' ? params.value : null
        if (!key || value === null) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing required --key and --value'
          )
        }
        const result = await this.runtime.browserStorageLocalSet({
          key,
          value,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.storage.local.clear') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserStorageLocalClear(
          this.extractBrowserTarget(params)
        )
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.storage.session.get') {
      try {
        const params = this.extractParams(request)
        const key = typeof params?.key === 'string' ? params.key : null
        if (!key) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --key')
        }
        const result = await this.runtime.browserStorageSessionGet({
          key,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.storage.session.set') {
      try {
        const params = this.extractParams(request)
        const key = typeof params?.key === 'string' ? params.key : null
        const value = typeof params?.value === 'string' ? params.value : null
        if (!key || value === null) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing required --key and --value'
          )
        }
        const result = await this.runtime.browserStorageSessionSet({
          key,
          value,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.storage.session.clear') {
      try {
        const params = this.extractParams(request)
        const result = await this.runtime.browserStorageSessionClear(
          this.extractBrowserTarget(params)
        )
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Download command ──

    if (request.method === 'browser.download') {
      try {
        const params = this.extractParams(request)
        const selector = typeof params?.selector === 'string' ? params.selector : null
        const path = typeof params?.path === 'string' ? params.path : null
        if (!selector || !path) {
          return this.errorResponse(
            request.id,
            'invalid_argument',
            'Missing required --selector and --path'
          )
        }
        const result = await this.runtime.browserDownload({
          selector,
          path,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── Highlight command ──

    if (request.method === 'browser.highlight') {
      try {
        const params = this.extractParams(request)
        const selector = typeof params?.selector === 'string' ? params.selector : null
        if (!selector) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --selector')
        }
        const result = await this.runtime.browserHighlight({
          selector,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    // ── New: exec passthrough + tab lifecycle ──

    if (request.method === 'browser.exec') {
      try {
        const params = this.extractParams(request)
        const command = typeof params?.command === 'string' ? params.command : null
        if (!command) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing required --command')
        }
        const result = await this.runtime.browserExec({
          command,
          ...this.extractBrowserTarget(params)
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.tabCreate') {
      try {
        const params = this.extractParams(request)
        const url = typeof params?.url === 'string' ? params.url : undefined
        const worktree = typeof params?.worktree === 'string' ? params.worktree : undefined
        const result = await this.runtime.browserTabCreate({ url, worktree })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'browser.tabClose') {
      try {
        const params = this.extractParams(request)
        const index = typeof params?.index === 'number' ? params.index : undefined
        const page =
          typeof params?.page === 'string' && params.page.length > 0 ? params.page : undefined
        const result = await this.runtime.browserTabClose({
          index,
          page,
          worktree: typeof params?.worktree === 'string' ? params.worktree : undefined
        })
        return this.successResponse(request.id, result)
      } catch (error) {
        return this.browserErrorResponse(request.id, error)
      }
    }

    if (request.method === 'terminal.focus') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { terminal?: unknown })
            : null
        const terminalHandle = params?.terminal
        if (typeof terminalHandle !== 'string' || terminalHandle.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing terminal handle')
        }
        const result = await this.runtime.focusTerminal(terminalHandle)
        return {
          id: request.id,
          ok: true,
          result: { focus: result },
          _meta: { runtimeId: this.runtime.getRuntimeId() }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    if (request.method === 'terminal.close') {
      try {
        const params =
          request.params && typeof request.params === 'object' && request.params !== null
            ? (request.params as { terminal?: unknown })
            : null
        const terminalHandle = params?.terminal
        if (typeof terminalHandle !== 'string' || terminalHandle.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing terminal handle')
        }
        const result = await this.runtime.closeTerminal(terminalHandle)
        return {
          id: request.id,
          ok: true,
          result: { close: result },
          _meta: { runtimeId: this.runtime.getRuntimeId() }
        }
      } catch (error) {
        return this.runtimeErrorResponse(request.id, error)
      }
    }

    return this.errorResponse(request.id, 'method_not_found', `Unknown method: ${request.method}`)
  }

  private errorResponse(id: string, code: string, message: string): RuntimeRpcResponse {
    return {
      id,
      ok: false,
      error: {
        code,
        message
      },
      _meta: {
        runtimeId: this.runtime.getRuntimeId()
      }
    }
  }

  private successResponse(id: string, result: unknown): RuntimeRpcResponse {
    return {
      id,
      ok: true,
      result,
      _meta: {
        runtimeId: this.runtime.getRuntimeId()
      }
    }
  }

  private extractParams(request: { params?: unknown }): Record<string, unknown> | null {
    return request.params && typeof request.params === 'object' && request.params !== null
      ? (request.params as Record<string, unknown>)
      : null
  }

  private extractBrowserTarget(params: Record<string, unknown> | null): {
    worktree?: string
    page?: string
  } {
    return {
      worktree: typeof params?.worktree === 'string' ? params.worktree : undefined,
      page: typeof params?.page === 'string' && params.page.length > 0 ? params.page : undefined
    }
  }

  // Why: browser errors carry a structured .code property (BrowserError from
  // cdp-bridge.ts) that maps directly to agent-facing error codes. We forward
  // that code rather than relying on the message-matching pattern used by
  // runtimeErrorResponse, which would require adding 10+ entries to the allowlist.
  private browserErrorResponse(id: string, error: unknown): RuntimeRpcResponse {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof (error as { code: unknown }).code === 'string'
    ) {
      return this.errorResponse(id, (error as { code: string }).code, error.message)
    }
    return this.runtimeErrorResponse(id, error)
  }

  private runtimeErrorResponse(id: string, error: unknown): RuntimeRpcResponse {
    const message = error instanceof Error ? error.message : String(error)
    if (
      message === 'runtime_unavailable' ||
      message === 'selector_not_found' ||
      message === 'selector_ambiguous' ||
      message === 'terminal_handle_stale' ||
      message === 'terminal_not_writable' ||
      message === 'terminal_exited' ||
      message === 'terminal_gone' ||
      message === 'no_active_terminal' ||
      message === 'repo_not_found' ||
      message === 'timeout' ||
      message === 'invalid_limit'
    ) {
      return this.errorResponse(id, message, message)
    }
    if (message === 'invalid_terminal_send') {
      return this.errorResponse(id, 'invalid_argument', 'Missing terminal send payload')
    }
    return this.errorResponse(id, 'runtime_error', message)
  }

  private writeMetadata(): void {
    const metadata: RuntimeMetadata = {
      runtimeId: this.runtime.getRuntimeId(),
      pid: this.pid,
      transport: this.transport,
      authToken: this.authToken,
      startedAt: this.runtime.getStartedAt()
    }
    writeRuntimeMetadata(this.userDataPath, metadata)
  }
}

export function createRuntimeTransportMetadata(
  userDataPath: string,
  pid: number,
  platform: NodeJS.Platform,
  runtimeId = 'runtime'
): RuntimeTransportMetadata {
  const endpointSuffix = runtimeId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 4) || 'rt'
  if (platform === 'win32') {
    return {
      kind: 'named-pipe',
      // Why: Windows named pipes do not get the same chmod hardening path as
      // Unix sockets, so include a per-runtime suffix to avoid exposing a
      // stable, guessable control endpoint name across launches.
      endpoint: `\\\\.\\pipe\\orca-${pid}-${endpointSuffix}`
    }
  }
  return {
    kind: 'unix',
    endpoint: join(userDataPath, `o-${pid}-${endpointSuffix}.sock`)
  }
}
