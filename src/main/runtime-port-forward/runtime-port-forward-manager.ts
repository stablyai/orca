import type { Server, Socket } from 'node:net'
import { randomUUID } from 'node:crypto'
import type {
  RuntimePortForward,
  RuntimePortForwardOpenRequest,
  RuntimePortForwardOpenResult
} from '../../shared/runtime-port-forwards'
import {
  EnvironmentPortForwardTunnel,
  PortForwardTunnelError,
  type PortForwardTunnelConnector
} from './runtime-port-forward-tunnel'
import { RuntimePortForwardActivity } from './runtime-port-forward-activity'
import { ForwardUseMeter } from './runtime-port-forward-use-meter'
import { pipeForwardedConnection } from './runtime-port-forward-pipe'
import { listenLoopback, type ListenOutcome } from './runtime-port-forward-listen'
import { forwardKey, isValidRuntimePortForwardRequest } from './runtime-port-forward-request'

// Why a few neighbours: dev tools print the URL they bound, so a nearby number stays recognisable.
const NEARBY_PORT_ATTEMPTS = 10

class ActiveForward {
  readonly sockets = new Set<Socket>()
  closed = false
  /** Last new connection or traffic that read as use, not keepalives. */
  lastUsedAt: number | null = null

  constructor(
    readonly state: RuntimePortForward,
    readonly servers: Server[]
  ) {}

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const server of this.servers) {
      server.close()
    }
    for (const socket of this.sockets) {
      socket.destroy()
    }
  }
}

export type RuntimePortForwardManagerOptions = {
  connector: PortForwardTunnelConnector
  onChange?: (forwards: RuntimePortForward[]) => void
  now?: () => number
  log?: (message: string) => void
}

/** Local listeners for remote host ports, each connection carried over that host's paired runtime channel. */
export class RuntimePortForwardManager {
  private readonly forwards = new Map<string, ActiveForward>()
  private readonly tunnels = new Map<string, EnvironmentPortForwardTunnel>()
  private readonly pending = new Map<string, Promise<RuntimePortForwardOpenResult>>()
  private readonly activity: RuntimePortForwardActivity
  private changeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly options: RuntimePortForwardManagerOptions) {
    this.activity = new RuntimePortForwardActivity(options.now)
  }

  list(environmentId?: string): RuntimePortForward[] {
    return Array.from(this.forwards.values(), (forward) => ({ ...forward.state })).filter(
      (forward) => !environmentId || forward.environmentId === environmentId
    )
  }

  /** One forward per remote port: a second request returns the existing listener. */
  open(request: RuntimePortForwardOpenRequest): Promise<RuntimePortForwardOpenResult> {
    if (!isValidRuntimePortForwardRequest(request)) {
      return Promise.resolve({
        ok: false,
        code: 'invalid_request',
        message: 'Invalid port forward.'
      })
    }
    const key = forwardKey(request.environmentId, request.remotePort)
    const existing = this.findByRemote(request.environmentId, request.remotePort)
    if (existing) {
      // A user or SSH request pins a forward that auto-forward created.
      if (existing.state.reason === 'auto' && request.reason !== 'auto') {
        existing.state.reason = request.reason
        this.emitChange()
      }
      return Promise.resolve({ ok: true, forward: { ...existing.state } })
    }
    const inFlight = this.pending.get(key)
    if (inFlight) {
      return inFlight
    }
    const attempt = this.start(request).finally(() => this.pending.delete(key))
    this.pending.set(key, attempt)
    return attempt
  }

  wake(environmentId: string): Promise<boolean> {
    return this.tunnelFor(environmentId)
      .warm(true)
      .then(() => true)
      .catch(() => (this.retireIdleTunnel(environmentId), false))
  }

  lastActivityAt(environmentId: string): number | null {
    return this.activity.lastAt(environmentId)
  }

  /** Same signal for one forward, so SSH can tell its own sessions apart from a dev server's. */
  forwardLastUsedAt(id: string): number | null {
    return this.forwards.get(id)?.lastUsedAt ?? null
  }

  close(id: string): RuntimePortForward | null {
    const forward = this.forwards.get(id)
    if (!forward) {
      return null
    }
    forward.close()
    this.forwards.delete(id)
    this.options.log?.(`[port-forward] closed localhost:${forward.state.localPort}`)
    this.retireIdleTunnel(forward.state.environmentId)
    this.emitChange()
    return { ...forward.state }
  }

  /** Drops every forward of an environment (removed, forgotten or destroyed). */
  closeEnvironment(environmentId: string): void {
    for (const forward of this.list(environmentId)) {
      this.close(forward.id)
    }
    this.tunnels.get(environmentId)?.close()
    this.tunnels.delete(environmentId)
    this.activity.forget(environmentId)
  }

  dispose(): void {
    for (const id of Array.from(this.forwards.keys())) {
      this.close(id)
    }
    for (const tunnel of this.tunnels.values()) {
      tunnel.close()
    }
    this.tunnels.clear()
    if (this.changeTimer) {
      clearTimeout(this.changeTimer)
    }
  }

  private findByRemote(environmentId: string, remotePort: number): ActiveForward | undefined {
    for (const forward of this.forwards.values()) {
      if (
        forward.state.environmentId === environmentId &&
        forward.state.remotePort === remotePort
      ) {
        return forward
      }
    }
    return undefined
  }

  private tunnelFor(environmentId: string): EnvironmentPortForwardTunnel {
    let tunnel = this.tunnels.get(environmentId)
    if (!tunnel) {
      tunnel = new EnvironmentPortForwardTunnel(environmentId, this.options.connector)
      this.tunnels.set(environmentId, tunnel)
    }
    return tunnel
  }

  private retireIdleTunnel(environmentId: string): void {
    if (this.list(environmentId).length === 0) {
      this.tunnels.get(environmentId)?.close()
      this.tunnels.delete(environmentId)
    }
  }

  private async start(
    request: RuntimePortForwardOpenRequest
  ): Promise<RuntimePortForwardOpenResult> {
    const tunnel = this.tunnelFor(request.environmentId)
    try {
      // Fail before binding (nothing listens for a dead tunnel); only user/SSH requests may wake the VM.
      await tunnel.warm(request.reason !== 'auto')
    } catch (error) {
      this.retireIdleTunnel(request.environmentId)
      return {
        ok: false,
        code: error instanceof PortForwardTunnelError ? error.code : 'tunnel_failed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
    const state: RuntimePortForward = {
      id: randomUUID(),
      environmentId: request.environmentId,
      remotePort: request.remotePort,
      localPort: 0,
      reason: request.reason,
      ...(request.label ? { label: request.label } : {}),
      createdAt: (this.options.now ?? Date.now)(),
      openConnections: 0,
      totalConnections: 0,
      bytesToHost: 0,
      bytesFromHost: 0
    }
    let forward: ActiveForward | null = null
    const accept = (socket: Socket): void => {
      if (forward) {
        this.accept(forward, socket)
      } else {
        socket.destroy()
      }
    }
    const bound = await this.bind(request, accept)
    if (!bound.ok) {
      this.retireIdleTunnel(request.environmentId)
      return bound.busy
        ? {
            ok: false,
            code: 'port_busy',
            message: `Port ${request.localPort || request.remotePort} is in use on this computer.`
          }
        : { ok: false, code: 'listen_failed', message: 'Orca could not listen on this computer.' }
    }
    state.localPort = bound.port!
    forward = new ActiveForward(state, bound.servers)
    this.forwards.set(state.id, forward)
    this.options.log?.(
      `[port-forward] localhost:${state.localPort} -> ${state.environmentId}:${state.remotePort} (${state.reason})`
    )
    this.emitChange()
    return { ok: true, forward: { ...state } }
  }

  private async bind(
    request: RuntimePortForwardOpenRequest,
    accept: (socket: Socket) => void
  ): Promise<ListenOutcome & { port?: number }> {
    if (request.localPort !== undefined) {
      return listenLoopback(request.localPort, accept)
    }
    const first = await listenLoopback(request.remotePort, accept)
    if (first.ok || request.exclusive || !first.busy) {
      return first
    }
    for (let offset = 1; offset <= NEARBY_PORT_ATTEMPTS; offset += 1) {
      const candidate = request.remotePort + offset
      if (candidate > 65_535) {
        break
      }
      const next = await listenLoopback(candidate, accept)
      if (next.ok || !next.busy) {
        return next
      }
    }
    return listenLoopback(0, accept)
  }

  private accept(forward: ActiveForward, socket: Socket): void {
    if (forward.closed) {
      socket.destroy()
      return
    }
    const { state } = forward
    forward.sockets.add(socket)
    state.openConnections += 1
    state.totalConnections += 1
    forward.lastUsedAt = this.activity.note(state.environmentId)
    const meter = new ForwardUseMeter()
    socket.setNoDelay(true)
    socket.pause()
    let released = false
    const release = (): void => {
      if (released) {
        return
      }
      released = true
      forward.sockets.delete(socket)
      state.openConnections -= 1
      this.emitChange()
    }
    socket.on('close', release)
    socket.on('error', () => socket.destroy())
    this.tunnelFor(state.environmentId)
      .open(state.remotePort)
      .then(
        (remote) => {
          if (socket.destroyed || forward.closed) {
            remote.destroy()
            return
          }
          pipeForwardedConnection(socket, remote, state, {
            sent: (bytes) => {
              if (meter.note((this.options.now ?? Date.now)(), bytes)) {
                forward.lastUsedAt = this.activity.note(state.environmentId)
              }
            },
            changed: () => this.emitChange()
          })
          this.emitChange()
        },
        (error: unknown) => {
          state.lastError = error instanceof Error ? error.message : String(error)
          socket.destroy()
          this.emitChange()
        }
      )
  }

  /** Coalesces per-connection churn so a page load does not flood the renderer. */
  private emitChange(): void {
    if (!this.options.onChange || this.changeTimer) {
      return
    }
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null
      this.options.onChange?.(this.list())
    }, 100)
  }
}

export {
  getRuntimePortForwardManager,
  installRuntimePortForwardManager,
  openRuntimePortForward
} from './runtime-port-forward-service'
