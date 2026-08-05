import { RpcControlProbeFollowUp } from './rpc-control-probe-follow-up'

// Why: RN auto-pongs pings natively, so JS needs an app-level probe to detect half-open sockets.
export const ACTIVITY_PROBE_INTERVAL_MS = 20_000
export const ACTIVITY_PROBE_TIMEOUT_MS = 8_000
// Why: a congested link parks the control reply behind queued terminal frames on
// the desktop, so while decoded inbound frames still arrive chain this many
// immediate re-probes before demoting — backlog gets ~24s to drain, while a
// wedged host (streams flowing, control dead) is still detected, never masked.
export const ACTIVITY_PROBE_MAX_EXTENSIONS = 2

type ActivityProbeDeps<TSocket> = {
  getConnectedSocket: () => TSocket | null
  nextId: () => string
  getControlResponseSequence: () => number
  getInboundActivitySequence: () => number
  rememberTimedOutControlId: (id: string) => void
  registerPendingProbe: (id: string, entry: { resolve: () => void; reject: () => void }) => void
  removePendingProbe: (id: string) => void
  sendProbe: (id: string) => boolean
  demote: (socket: TSocket) => void
}

export type RpcClientActivityProbe<TSocket> = {
  run: (expectedSocket?: TSocket | null, queueAfterCurrent?: boolean) => void
  start: () => void
  stop: () => void
  finishFollowUp: (socket?: TSocket) => void
}

// Why: stream frames can flow while control RPC is wedged; only a control
// response satisfies this probe — inbound frames merely extend its deadline.
export function createRpcClientActivityProbe<TSocket>(
  deps: ActivityProbeDeps<TSocket>
): RpcClientActivityProbe<TSocket> {
  let timer: ReturnType<typeof setInterval> | null = null
  let extensions = 0
  const followUp = new RpcControlProbeFollowUp<TSocket>(deps.getConnectedSocket, run)

  function run(
    expectedSocket: TSocket | null = deps.getConnectedSocket(),
    queueAfterCurrent = false
  ): void {
    const socket = deps.getConnectedSocket()
    if (!socket || socket !== expectedSocket) {
      return
    }
    if (!followUp.begin(socket, queueAfterCurrent)) {
      return
    }
    const id = deps.nextId()
    const probeControlResponseSequence = deps.getControlResponseSequence()
    const probeInboundSequence = deps.getInboundActivitySequence()
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      deps.removePendingProbe(id)
      deps.rememberTimedOutControlId(id)
      const controlResponded = deps.getControlResponseSequence() > probeControlResponseSequence
      followUp.finish(socket)
      if (controlResponded) {
        extensions = 0
        return
      }
      if (
        deps.getInboundActivitySequence() > probeInboundSequence &&
        extensions < ACTIVITY_PROBE_MAX_EXTENSIONS
      ) {
        extensions++
        console.log('[net] activity-probe extended — inbound frames without a control response', {
          extension: extensions
        })
        run(socket)
        return
      }
      extensions = 0
      console.log('[net] activity-probe TIMEOUT — forcing reconnect')
      deps.demote(socket)
    }, ACTIVITY_PROBE_TIMEOUT_MS)
    deps.registerPendingProbe(id, {
      resolve: () => {
        if (timedOut) {
          return
        }
        extensions = 0
        clearTimeout(timeout)
        followUp.finish(socket)
      },
      reject: () => {
        if (timedOut) {
          return
        }
        clearTimeout(timeout)
        followUp.finish(socket)
      }
    })
    if (!deps.sendProbe(id)) {
      clearTimeout(timeout)
      deps.removePendingProbe(id)
      followUp.finish(socket)
    }
  }

  return {
    run,
    start: () => {
      stopTimer()
      extensions = 0
      timer = setInterval(() => run(), ACTIVITY_PROBE_INTERVAL_MS)
    },
    stop: stopTimer,
    finishFollowUp: (socket?: TSocket) => followUp.finish(socket)
  }

  function stopTimer(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }
}
