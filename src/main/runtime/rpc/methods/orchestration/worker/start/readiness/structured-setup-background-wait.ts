import type { AwaitingWorkerStart } from './worker-start-background-readiness'
import type { StructuredWorkerSetupGate } from './worker-start-structured-setup-gate'

/** Waits on a structured worker's Setup for up to `timeoutMs`; null when Setup could not be observed. */
export type StructuredSetupWait = (
  signal: AbortSignal,
  timeoutMs: number
) => Promise<StructuredWorkerSetupGate | null>

/** Waits out Setup until the start's deadline, then settles the start from its verdict. */
export async function watchStructuredSetup(
  start: AwaitingWorkerStart,
  waitForSetup: StructuredSetupWait,
  signal: AbortSignal,
  clock: { readyBy: () => number; dispose: () => void },
  awaiting: () => boolean
): Promise<void> {
  try {
    const verdict = await waitForSetup(signal, Math.max(0, clock.readyBy() - Date.now()))
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
