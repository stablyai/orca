import { RpcControlProbeFollowUp } from './rpc-control-probe-follow-up'
import { isRpcDeliveryUnknown } from './rpc-delivery-ambiguity'
import type { RpcResponse } from './types'

export const CONTROL_PROBE_TIMEOUT_MS = 8_000
const CONTROL_PROBE_INTERVAL_MS = 20_000
// Why: mirrors the direct client — decoded inbound frames prove the relay link
// drains while a control reply may sit behind queued terminal backlog, so chain
// bounded re-probes before failing; a wedged host is still detected, never masked.
const CONTROL_PROBE_MAX_EXTENSIONS = 2

type MobileRelayControlProbeDeps = {
  isActive: () => boolean
  sendProbe: () => Promise<RpcResponse>
  getControlResponseSequence: () => number
  getInboundActivitySequence: () => number
  onDemote: (error: unknown) => void
}

export type MobileRelayControlProbe = {
  probe: (queueAfterCurrent?: boolean) => void
  startTimer: () => void
  stopTimer: () => void
}

export function createMobileRelayControlProbe(
  deps: MobileRelayControlProbeDeps
): MobileRelayControlProbe {
  let timer: ReturnType<typeof setInterval> | null = null
  let extensions = 0
  const followUp = new RpcControlProbeFollowUp<boolean>(
    () => (deps.isActive() ? true : null),
    probe
  )

  function probe(queueAfterCurrent = false): void {
    if (!deps.isActive()) {
      return
    }
    if (!followUp.begin(true, queueAfterCurrent)) {
      return
    }
    const probeControlResponseSequence = deps.getControlResponseSequence()
    const probeInboundSequence = deps.getInboundActivitySequence()
    void deps.sendProbe().then(
      () => {
        extensions = 0
        followUp.finish(true)
      },
      (error: unknown) => {
        const controlResponded = deps.getControlResponseSequence() > probeControlResponseSequence
        followUp.finish(true)
        if (!deps.isActive()) {
          return
        }
        if (isRpcDeliveryUnknown(error) && controlResponded) {
          extensions = 0
          return
        }
        if (
          isRpcDeliveryUnknown(error) &&
          deps.getInboundActivitySequence() > probeInboundSequence &&
          extensions < CONTROL_PROBE_MAX_EXTENSIONS
        ) {
          extensions += 1
          probe()
          return
        }
        extensions = 0
        deps.onDemote(error)
      }
    )
  }

  return {
    probe,
    startTimer: () => {
      if (!deps.isActive() || timer) {
        return
      }
      timer = setInterval(() => probe(), CONTROL_PROBE_INTERVAL_MS)
    },
    stopTimer: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      followUp.finish()
    }
  }
}
