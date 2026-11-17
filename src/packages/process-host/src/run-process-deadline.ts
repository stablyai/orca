import type { BufferedProcessChild, ProcessSpec } from './process-spec'
import { DEFAULT_PROCESS_TIMEOUT_MS } from './process-spec'

// Queue wait a worker-hosted launch may spend before its own deadline starts.
const HOSTED_LAUNCH_ALLOWANCE_MS = 30_000

export function startProcessDeadline(
  spec: ProcessSpec,
  child: BufferedProcessChild,
  hosted: boolean,
  isSettled: () => boolean,
  onTimeout: () => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const startTimeout = (): void => {
    if (spec.timeoutMs === null || isSettled() || timer) {
      return
    }
    timer = setTimeout(onTimeout, spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)
    timer.unref?.()
  }
  let launchTimer: ReturnType<typeof setTimeout> | undefined
  if (hosted && spec.timeoutMs !== null) {
    // A hosted launch waits behind others on the worker; like a native spawn, the deadline starts once the process exists.
    child.once('spawn', () => {
      clearTimeout(launchTimer)
      startTimeout()
    })
    // A launch the worker never completes still ends, after the run's own budget plus a queue allowance.
    launchTimer = setTimeout(
      onTimeout,
      (spec.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS) + HOSTED_LAUNCH_ALLOWANCE_MS
    )
    launchTimer.unref?.()
  } else {
    startTimeout()
  }

  return () => {
    clearTimeout(timer)
    clearTimeout(launchTimer)
  }
}
