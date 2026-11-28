import type { OrchestrationDbSwap } from './orchestration-db-compaction'
import { settleWithinMs } from '../../../../startup/quit/quit-teardown-deadline'

// The swap renames files; this bounds quit whatever the disk does.
const SWAP_CAP_MS = 2_000

export type OrchestrationDbQuitOwner = {
  swapCompactedOrchestrationDbForQuit(): Promise<OrchestrationDbSwap>
}

/** Last step of a clean desktop quit, after every other teardown settled: nothing else uses the file. */
export async function swapCompactedOrchestrationDbAtQuit(
  owner: OrchestrationDbQuitOwner | null | undefined
): Promise<void> {
  if (!owner) {
    return
  }
  try {
    const settled = await settleWithinMs(owner.swapCompactedOrchestrationDbForQuit(), SWAP_CAP_MS)
    if (settled.outcome !== 'settled' || settled.value.kind === 'failed') {
      console.warn('[orchestration] database compaction failed', settled)
    } else if (settled.value.kind !== 'none') {
      console.info('[orchestration] database compaction', settled.value)
    }
  } catch (error) {
    console.warn('[orchestration] database compaction failed', error)
  }
}
