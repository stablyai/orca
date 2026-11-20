import { PrioritySemaphore } from '../../../shared/concurrency/priority-semaphore'

/** Each background generation starts an agent CLI from main; a launch burst must not start one per chat at once. */
const MAX_RUNNING = 3
/** A hung CLI runs until its own deadline; after this its slot admits the next run. */
const SLOT_HOLD_LIMIT_MS = 30_000

export const USER_REQUEST_PRIORITY = 0
export const BACKGROUND_PRIORITY = 1

const slots = new PrioritySemaphore(MAX_RUNNING)

/** Runs `run` once a slot frees; lower priority runs first, and a function priority is reread at each grant. */
export async function runInBackgroundGenerationSlot<T>(
  priority: Parameters<PrioritySemaphore['acquire']>[0],
  run: () => Promise<T>
): Promise<T> {
  const release = await slots.acquire(priority)
  const timer = setTimeout(release, SLOT_HOLD_LIMIT_MS)
  try {
    return await run()
  } finally {
    clearTimeout(timer)
    release()
  }
}
