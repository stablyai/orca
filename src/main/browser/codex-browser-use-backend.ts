import { createServer, type Server, type Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  defaultCodexBrowserUseSocketPath,
  sendBrowserUseMessage,
  type CodexBrowserUseAdapter,
  type CodexBrowserUseBackendOptions,
  type CodexBrowserUseRpcRequest
} from './codex-browser-use-protocol'
import { CodexBrowserUseRpcRouter } from './codex-browser-use-rpc-router'

const MAX_FRAME_BYTES = 16 * 1024 * 1024

async function preparePosixSocketPath(socketPath: string): Promise<void> {
  const directory = dirname(socketPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryStat = await lstat(directory)
  const currentUserId = process.getuid?.()
  if (
    !directoryStat.isDirectory() ||
    directoryStat.isSymbolicLink() ||
    (currentUserId !== undefined && directoryStat.uid !== currentUserId)
  ) {
    throw new Error('Browser backend socket directory is not owned by the current user')
  }
  await chmod(directory, 0o700)

  try {
    const socketStat = await lstat(socketPath)
    if (
      !socketStat.isSocket() ||
      (currentUserId !== undefined && socketStat.uid !== currentUserId)
    ) {
      throw new Error('Browser backend socket path is not a user-owned socket')
    }
    await rm(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

export type CodexBrowserUseConnectionAttachment = {
  sessionId: string
  worktreeId: string
  browserPageId: string
}

export type CodexBrowserUseConnectionContext = {
  id: string
  closed: boolean
  attachments: Map<string, CodexBrowserUseConnectionAttachment>
  getSessionId: () => string | null
  bindSessionId: (sessionId: string) => void
}

export class CodexBrowserUseBackend {
  private readonly socketPath: string
  private server: Server | null = null
  private readonly router: CodexBrowserUseRpcRouter
  private readonly sockets = new Set<Socket>()
  private ownsSocketPath = false

  constructor(
    private readonly adapter: CodexBrowserUseAdapter,
    options: CodexBrowserUseBackendOptions = {}
  ) {
    this.router = new CodexBrowserUseRpcRouter(adapter)
    this.socketPath =
      options.socketPath ??
      defaultCodexBrowserUseSocketPath(options.platform ?? process.platform, options.processId)
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }
    if (process.platform !== 'win32') {
      await preparePosixSocketPath(this.socketPath)
    }

    const server = createServer((socket) => this.accept(socket))
    this.server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.socketPath, () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      if (process.platform !== 'win32') {
        this.ownsSocketPath = true
        await chmod(this.socketPath, 0o600)
      }
    } catch (error) {
      this.server = null
      server.close()
      if (process.platform !== 'win32' && this.ownsSocketPath) {
        this.ownsSocketPath = false
        await rm(this.socketPath, { force: true })
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    for (const socket of this.sockets) {
      socket.destroy()
    }
    this.sockets.clear()
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (process.platform !== 'win32' && this.ownsSocketPath) {
      this.ownsSocketPath = false
      await rm(this.socketPath, { force: true })
    }
    this.router.clear()
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    let pending = Buffer.alloc(0)
    let boundSessionId: string | null = null
    const context: CodexBrowserUseConnectionContext = {
      id: randomUUID(),
      closed: false,
      attachments: new Map(),
      getSessionId: () => boundSessionId,
      bindSessionId: (sessionId) => {
        boundSessionId ??= sessionId
      }
    }
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, Buffer.from(chunk)])
      while (pending.length >= 4) {
        const length = pending.readUInt32LE(0)
        if (length > MAX_FRAME_BYTES) {
          // An oversized prefix is untrusted and has no safe request id to answer.
          socket.destroy()
          return
        }
        if (pending.length < length + 4) {
          return
        }
        const payload = pending.subarray(4, length + 4).toString('utf8')
        pending = pending.subarray(length + 4)
        void this.handlePayload(socket, payload, context)
      }
    })
    socket.once('close', () => {
      this.sockets.delete(socket)
      context.closed = true
      const attachments = [...context.attachments.values()]
      context.attachments.clear()
      void Promise.allSettled(
        attachments.map((attachment) =>
          this.adapter.detach(
            context.id,
            attachment.sessionId,
            attachment.worktreeId,
            attachment.browserPageId
          )
        )
      )
    })
  }

  private async handlePayload(
    socket: Socket,
    payload: string,
    context: CodexBrowserUseConnectionContext
  ): Promise<void> {
    let request: CodexBrowserUseRpcRequest
    try {
      request = JSON.parse(payload) as CodexBrowserUseRpcRequest
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        throw new Error('Invalid JSON-RPC request')
      }
    } catch (error) {
      sendBrowserUseMessage(socket, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: error instanceof Error ? error.message : String(error) }
      })
      return
    }

    if (request.id == null) {
      return
    }
    try {
      const requestSessionId = request.params?.session_id
      if (typeof requestSessionId === 'string') {
        const boundSessionId = context.getSessionId()
        if (boundSessionId && boundSessionId !== requestSessionId) {
          throw new Error('Browser backend connection cannot change Codex sessions')
        }
        context.bindSessionId(requestSessionId)
      }
      const result = await this.router.dispatch(request, context, (method, params) => {
        sendBrowserUseMessage(socket, { jsonrpc: '2.0', method, params })
      })
      sendBrowserUseMessage(socket, { jsonrpc: '2.0', id: request.id, result })
    } catch (error) {
      console.warn(
        `[codex-browser-use] failed ${request.method}: ${error instanceof Error ? error.message : String(error)}`
      )
      sendBrowserUseMessage(socket, {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: 1, message: error instanceof Error ? error.message : String(error) }
      })
    }
  }
}
