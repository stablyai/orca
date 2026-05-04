// Why: this is the single security boundary for the bundled CLI. It owns
// transport setup (unix socket / named pipe), auth-token enforcement, and
// bootstrap-metadata publication so a running runtime is always discoverable
// via exactly one on-disk file. Method handling lives in `rpc/` so this file
// stays easy to audit in one sitting.
import { randomBytes } from 'crypto'
import { createServer, type Server, type Socket } from 'net'
import { chmodSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import type { RuntimeMetadata, RuntimeTransportMetadata } from '../../shared/runtime-bootstrap'
import type { OrcaRuntimeService } from './orca-runtime'
import { writeRuntimeMetadata } from './runtime-metadata'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcRequest, RpcResponse } from './rpc/core'
import { errorResponse } from './rpc/errors'

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
  private readonly dispatcher: RpcDispatcher
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
    this.dispatcher = new RpcDispatcher({ runtime })
    this.userDataPath = userDataPath
    this.pid = pid
    this.platform = platform
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }

    // Why: processes killed by SIGKILL / OOM-kill / forced-shutdown skip
    // stop() and leave behind `o-<pid>-*.sock` files in userData. Sweeping
    // dead-pid sockets at startup keeps the directory from accumulating
    // orphans over the app's lifetime. Named-pipe transports on Windows do
    // not leave filesystem entries in userData, so the sweep is a no-op
    // there.
    if (this.platform !== 'win32') {
      sweepOrphanedRuntimeSockets(this.userDataPath, this.pid)
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
          `${JSON.stringify(this.buildError('unknown', 'request_too_large', 'RPC request exceeds the maximum size'))}\n`
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

  private async handleMessage(rawMessage: string): Promise<RpcResponse> {
    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      return this.buildError('unknown', 'bad_request', 'Invalid JSON request')
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      return this.buildError('unknown', 'bad_request', 'Missing request id')
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      return this.buildError(request.id, 'bad_request', 'Missing RPC method')
    }
    if (typeof request.authToken !== 'string' || request.authToken.length === 0) {
      return this.buildError(request.id, 'unauthorized', 'Missing auth token')
    }
    if (request.authToken !== this.authToken) {
      return this.buildError(request.id, 'unauthorized', 'Invalid auth token')
    }

    return this.dispatcher.dispatch(request)
  }

  private buildError(id: string, code: string, message: string): RpcResponse {
    return errorResponse(id, { runtimeId: this.runtime.getRuntimeId() }, code, message)
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

/**
 * Why: the regex MUST stay in lockstep with createRuntimeTransportMetadata()
 * below, which emits `o-${pid}-${endpointSuffix}.sock` where endpointSuffix
 * is `[A-Za-z0-9_-]{1,4}` (derived from a sanitised runtimeId prefix, or
 * `'rt'` as the fallback). The invariant is covered by a unit test so any
 * future change to the transport-name shape trips CI.
 */
export const RUNTIME_SOCKET_NAME_REGEX = /^o-(\d+)-[A-Za-z0-9_-]+\.sock$/

export function sweepOrphanedRuntimeSockets(userDataPath: string, ownPid: number): void {
  let entries: string[]
  try {
    entries = readdirSync(userDataPath)
  } catch {
    // Why: first-launch userData may not exist yet; the cold-start path
    // below will create it. Nothing to sweep in that case.
    return
  }
  for (const entry of entries) {
    const match = RUNTIME_SOCKET_NAME_REGEX.exec(entry)
    if (!match) {
      continue
    }
    const pid = Number(match[1])
    if (!Number.isFinite(pid)) {
      continue
    }
    // Why: never touch the current process's socket. start() already
    // rmSync's it if it exists, but belt-and-braces — a bug in the own-pid
    // path here would rmSync a socket we're about to bind to.
    if (pid === ownPid) {
      continue
    }
    try {
      // Why: signal 0 is the POSIX liveness probe — it delivers no signal
      // but returns success iff the pid resolves AND the caller has
      // permission to signal it. ESRCH = no such process; EPERM = pid
      // exists but owned by another user, which is extremely unusual on a
      // desktop app's userData dir but we conservatively leave those
      // sockets alone.
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        try {
          rmSync(join(userDataPath, entry), { force: true })
        } catch {
          // Why: best-effort sweep — a permission error on unlink is fine
          // to ignore; the socket will be cleaned by a later start() or
          // by the OS on reboot.
        }
      }
    }
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
