import type { ConnectionState } from './types'

// Why: RN auto-pongs pings natively, so JS needs an app-level probe to detect half-open sockets.
const ACTIVITY_PROBE_INTERVAL_MS = 20_000
const ACTIVITY_PROBE_TIMEOUT_MS = 8_000

export type RpcActivityProbeDependencies = {
  getState: () => ConnectionState
  getSocket: () => WebSocket | null
  // Counts only validated inbound traffic, so a malformed frame cannot pass for liveness.
  getInboundSequence: () => number
  nextId: () => string
  registerPending: (id: string, onSettled: () => void) => void
  clearPending: (id: string) => void
  sendProbe: (id: string) => boolean
  forceReconnect: (socket: WebSocket) => void
}

export type RpcActivityProbe = {
  start: () => void
  stop: () => void
  run: () => void
}

export function createRpcActivityProbe(
  dependencies: RpcActivityProbeDependencies
): RpcActivityProbe {
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight = false

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function run(): void {
    const probeWs = dependencies.getSocket()
    if (dependencies.getState() !== 'connected' || !probeWs || inFlight) {
      return
    }
    inFlight = true
    const id = dependencies.nextId()
    const probeInboundSequence = dependencies.getInboundSequence()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      inFlight = false
      dependencies.clearPending(id)
      // Why: any validated frame answered for the socket, even if this probe did not.
      if (dependencies.getInboundSequence() > probeInboundSequence) {
        return
      }
      console.log('[net] activity-probe TIMEOUT — forcing reconnect', {
        state: dependencies.getState()
      })
      // Why: stale probe timers must not close a replacement socket.
      if (probeWs === dependencies.getSocket() && probeWs.readyState === WebSocket.OPEN) {
        dependencies.forceReconnect(probeWs)
      }
    }, ACTIVITY_PROBE_TIMEOUT_MS)

    dependencies.registerPending(id, () => {
      if (timedOut) {
        return
      }
      inFlight = false
      clearTimeout(timeout)
    })

    if (!dependencies.sendProbe(id)) {
      inFlight = false
      clearTimeout(timeout)
      dependencies.clearPending(id)
    }
  }

  return {
    run,
    stop,
    start(): void {
      stop()
      timer = setInterval(run, ACTIVITY_PROBE_INTERVAL_MS)
    }
  }
}
