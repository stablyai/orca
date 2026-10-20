import { settleWithinMs, type SettledWithinMs } from '../quit-teardown-deadline'

export type RepositoryAddScriptsShutdownTarget = {
  closeRepositoryAddScripts(): Promise<void>
  hasUnsettledRepositoryAddScriptRuns(): boolean
}

// Why 5s: orcad's startup-failure cleanup is awaited outside its signal deadline.
export const ORCAD_REPOSITORY_ADD_SCRIPTS_CLEANUP_BUDGET_MS = 5_000

// Fixed text: a close failure or an unverified run must never surface script text or paths.
const UNVERIFIED_MESSAGE = 'Repository add script cleanup could not be verified.'

// Seals synchronously; a throwing close becomes a rejection so callers handle one shape.
function startClose(target: RepositoryAddScriptsShutdownTarget): Promise<void> {
  try {
    return target.closeRepositoryAddScripts()
  } catch (error) {
    return Promise.reject(error)
  }
}

/** Desktop quit: seals at the call and never rejects, so it can join the shared teardown deadline. */
export function closeRepositoryAddScriptsForQuit(
  target: RepositoryAddScriptsShutdownTarget | null | undefined
): Promise<void> {
  if (!target) {
    return Promise.resolve()
  }
  return startClose(target).then(
    () => {
      if (target.hasUnsettledRepositoryAddScriptRuns()) {
        console.warn(`[repository-add-scripts] ${UNVERIFIED_MESSAGE}`)
      }
    },
    () => console.warn(`[repository-add-scripts] ${UNVERIFIED_MESSAGE}`)
  )
}

/**
 * orcad: registers, as soon as the runtime exists, the cleanup that waits for the close, so a
 * failed startup closes too. `start` seals without waiting; the one budget runs from the first
 * start, and a timed-out, failed or unverified close fails the teardown so the fences stay held.
 */
export function registerOrcadRepositoryAddScriptsCleanup(
  target: RepositoryAddScriptsShutdownTarget,
  registerCleanup: (cleanup: () => Promise<void>) => void,
  budgetMs = ORCAD_REPOSITORY_ADD_SCRIPTS_CLEANUP_BUDGET_MS
): { start: () => void } {
  // Cached as the non-rejecting bounded result, so a pending RPC stop never strands a rejection.
  let settled: Promise<SettledWithinMs<void>> | null = null
  const start = (): Promise<SettledWithinMs<void>> =>
    (settled ??= settleWithinMs(startClose(target), budgetMs))
  registerCleanup(async () => {
    const result = await start()
    if (result.outcome !== 'settled' || target.hasUnsettledRepositoryAddScriptRuns()) {
      throw new Error(UNVERIFIED_MESSAGE)
    }
  })
  return {
    start: () => {
      void start()
    }
  }
}
