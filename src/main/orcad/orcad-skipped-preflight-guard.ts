/**
 * Bounds the profile import of a start that skipped its preflight on a cached verdict. If the
 * runtime broke in a way the fingerprint missed, the import is where it shows: a failure, or a hang.
 * Either one re-runs the real probe now, so a broken runtime exits as a configuration fault inside
 * the client's readiness budget, and a healthy one keeps the import's own outcome.
 */
import { reprobeBundledOrcadStartup } from './orcad-profile-preflight'
import { wasStartupPreflightSkipped } from './orcad-startup-preflight-verdict'

export { settleSlotStartupPreflightSkip } from './orcad-startup-preflight-verdict'

// With the probe's own 90 s bound, a broken runtime still fails before the client's 180 s wait.
export const SKIPPED_PREFLIGHT_IMPORT_GUARD_MS = 45_000

export type SkippedPreflightGuardDeps = {
  skipped: () => boolean
  reprobe: () => Promise<void>
  timeoutMs: number
}

const defaultDeps: SkippedPreflightGuardDeps = {
  skipped: wasStartupPreflightSkipped,
  reprobe: reprobeBundledOrcadStartup,
  timeoutMs: SKIPPED_PREFLIGHT_IMPORT_GUARD_MS
}

export async function guardSkippedPreflightImport<T>(
  work: Promise<T>,
  deps: SkippedPreflightGuardDeps = defaultDeps
): Promise<T> {
  if (!deps.skipped()) {
    return work
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => resolve('timed-out'), deps.timeoutMs)
  })
  const settled = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error })
  )
  try {
    const first = await Promise.race([settled, timedOut])
    if (first === 'timed-out') {
      // A broken runtime throws here; a healthy one means the import is just slow.
      await deps.reprobe()
      return await work
    }
    if (!first.ok) {
      // A runtime fault surfaces as the probe's configuration error; otherwise the import's own.
      await deps.reprobe()
      throw first.error
    }
    return first.value
  } finally {
    clearTimeout(timer)
  }
}

/** orcad's profile import, bounded when this start skipped its preflight. */
export async function startGuardedProfileState(userDataPath: string) {
  const { createOrcadProfileStateStartup } = await import('./orcad-profile-state-startup')
  return guardSkippedPreflightImport(createOrcadProfileStateStartup(userDataPath))
}
