import { SETUP_WAIT_GATE_MAX_MS } from '../../../../../../../../shared/agent-launch/startup/setup-wait-output-gate'
import type { AwaitingWorkerStart } from './worker-start-background-readiness'
import type { StructuredWorkerSetupGate } from './worker-start-structured-setup-gate'

/** Waits on a structured worker's Setup for up to `timeoutMs`. */
export type StructuredSetupWait = (
  signal: AbortSignal,
  timeoutMs: number
) => Promise<StructuredWorkerSetupGate>

/** Waits on Setup for as long as a terminal worker's wrapper does (from launch), then settles the
 *  start from its verdict. */
export async function watchStructuredSetup(
  start: AwaitingWorkerStart,
  waitForSetup: StructuredSetupWait,
  signal: AbortSignal,
  clock: { dispose: () => void },
  awaiting: () => boolean
): Promise<void> {
  try {
    const setupDeadline = start.launchedAt + SETUP_WAIT_GATE_MAX_MS
    const verdict = await waitForSetup(signal, Math.max(0, setupDeadline - Date.now()))
    if (!awaiting()) {
      return
    }
    start.db.recordWorkerStage({ dispatchId: start.dispatchId, stage: 'agent_readiness' })
    await start.handOver(verdict)
  } catch (error) {
    if (awaiting()) {
      await start.fail(error, 'setup_wait')
    }
  } finally {
    clock.dispose()
  }
}
