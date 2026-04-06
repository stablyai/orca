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
        const terminalHandle =
          request.params && typeof request.params === 'object' && request.params !== null
            ? ((request.params as { terminal?: unknown }).terminal ?? null)
            : null

        if (typeof terminalHandle !== 'string' || terminalHandle.length === 0) {
          return this.errorResponse(request.id, 'invalid_argument', 'Missing terminal handle')
        }

        const result = await this.runtime.readTerminal(terminalHandle)
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

        if (params?.for !== 'exit') {
          return this.errorResponse(
            request.id,
            'not_supported_in_v1',
            'Only terminal wait --for exit is supported in focused v1'
          )
        }

        const timeoutMs =
          typeof params?.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
            ? params.timeoutMs
            : undefined

        const result = await this.runtime.waitForTerminal(terminalHandle, { timeoutMs })
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

  private runtimeErrorResponse(id: string, error: unknown): RuntimeRpcResponse {
    const message = error instanceof Error ? error.message : String(error)
    if (
      message === 'runtime_unavailable' ||
      message === 'selector_not_found' ||
      message === 'selector_ambiguous' ||
      message === 'terminal_handle_stale' ||
      message === 'terminal_not_writable' ||
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
