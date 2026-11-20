import { PrioritySemaphore } from '../../../shared/concurrency/priority-semaphore'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from './source-control-generation-limits'

/** Each background generation starts an agent CLI from main; a launch burst must not start one per chat at once. */
const MAX_RUNNING = 3
/** Covers an account-lock wait plus the CLI's own deadline; only a child whose termination failed outlives it. */
const SLOT_HOLD_LIMIT_MS = 2 * SOURCE_CONTROL_GENERATION_TIMEOUT_MS + 15_000

export const USER_REQUEST_PRIORITY = 0
export const BACKGROUND_PRIORITY = 1

const slots = new PrioritySemaphore(MAX_RUNNING)

/**
 * Runs `run` once a slot frees; lower priority runs first, and a function priority is reread at
 * each grant. `slotHeld` turns false once the hold limit frees the slot, so a run still waiting
 * to start its CLI must not start it.
 */
export async function runInBackgroundGenerationSlot<T>(
  priority: Parameters<PrioritySemaphore['acquire']>[0],
  run: (slotHeld: () => boolean) => Promise<T>
): Promise<T> {
  const release = await slots.acquire(priority)
  let held = true
  const timer = setTimeout(() => {
    held = false
    release()
  }, SLOT_HOLD_LIMIT_MS)
  try {
    return await run(() => held)
  } finally {
    clearTimeout(timer)
    release()
  }
}
