import { isDaemonEndpointGoneError } from '../../protocol/daemon-errors'
import { inspectProcessSignal } from '../../endpoint/identity/daemon-process-inspection'

/**
 * Delays between reconnect attempts after a preserved daemon's connection drops; the last repeats.
 * Loss needs this many attempts in a row to find the endpoint refused or missing: a timeout or any
 * other error cannot tell a busy host from a dead one, so it restarts the count.
 */
export const PRESERVED_ENDPOINT_LOSS_PROBE_DELAYS_MS: readonly number[] = [
  500, 2_000, 5_000, 30_000
]
export const PRESERVED_ENDPOINT_LOSS_REQUIRED_GONE = 3

export type PreservedEndpointLossVerdict = 'gone' | 'reachable' | 'abandoned'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A gone endpoint alone does not prove the process is gone on POSIX: its socket name can be
 * unlinked under a live daemon. A Windows pipe exists only while its server handle is open, and
 * PID reuse makes a PID probe unsound there, so the missing pipe is the proof.
 */
export function preservedDaemonProcessExited(pid: number | undefined): boolean {
  if (process.platform === 'win32') {
    return true
  }
  return pid !== undefined && inspectProcessSignal(pid) === 'missing'
}

/** Decide whether a daemon Orca cannot respawn is gone for good, so its PTYs can end as host loss. */
export async function confirmPreservedEndpointLoss(args: {
  connect: () => Promise<void>
  shouldContinue: () => boolean
  processExited: () => boolean
  delaysMs?: readonly number[]
  requiredGone?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<PreservedEndpointLossVerdict> {
  const sleep = args.sleep ?? delay
  const delays = args.delaysMs ?? PRESERVED_ENDPOINT_LOSS_PROBE_DELAYS_MS
  const requiredGone = args.requiredGone ?? PRESERVED_ENDPOINT_LOSS_REQUIRED_GONE
  let gone = 0
  for (let attempt = 0; ; attempt++) {
    await sleep(delays[Math.min(attempt, delays.length - 1)] ?? 0)
    if (!args.shouldContinue()) {
      return 'abandoned'
    }
    try {
      await args.connect()
      return 'reachable'
    } catch (error) {
      gone = isDaemonEndpointGoneError(error) && args.processExited() ? gone + 1 : 0
    }
    if (gone >= requiredGone) {
      return 'gone'
    }
  }
}
