import type { OrchestrationDbSwap } from './orchestration-db-compaction'
import { settlesWithin } from './orchestration-db-compaction-files'

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
    const result = await settlesWithin(owner.swapCompactedOrchestrationDbForQuit(), SWAP_CAP_MS)
    if (result === 'late' || result.kind === 'failed') {
      console.warn('[orchestration] database compaction failed', result)
    } else if (result.kind !== 'none') {
      console.info('[orchestration] database compaction', result)
    }
  } catch (error) {
    console.warn('[orchestration] database compaction failed', error)
  }
}
