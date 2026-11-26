import {
  createSetupWaitGate,
  SETUP_WAIT_GATE_MAX_MS
} from '../../../../shared/agent-launch/startup/setup-wait-output-gate'
import type { WorktreeStartupReadinessHost } from './runtime-worktree-startup-readiness'

export function waitForWorktreeSetupGate(
  host: WorktreeStartupReadinessHost,
  ptyId: string,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const gate = createSetupWaitGate(true)
    let unsubscribe: (() => void) | undefined
    const finish = (ready: boolean): void => {
      clearTimeout(timer)
      unsubscribe?.()
      signal.removeEventListener('abort', abort)
      resolve(ready)
    }
    const abort = (): void => finish(false)
    const timer = setTimeout(abort, SETUP_WAIT_GATE_MAX_MS)
    const observe = (data: string): void => {
      const { phase } = gate.observe(data)
      if (phase === 'started' || phase === 'failed') {
        finish(phase === 'started')
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    unsubscribe = host.subscribeToData(ptyId, observe)
    observe(host.readRecentOutput(ptyId) ?? '')
  })
}
