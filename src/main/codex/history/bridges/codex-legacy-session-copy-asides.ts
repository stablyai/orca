import { lstatIfPresent } from './codex-legacy-session-copy-name-ops'

/**
 * The legacy copy's own bytes stay under `<name>.orca-legacy-copy.<attempt>` once its source is
 * linked in; each attempt reserves a name of its own, so no step ever replaces or removes one.
 */
export const LEGACY_SESSION_COPY_ASIDE_SUFFIX = '.orca-legacy-copy'
/** Attempts that each keep an aside name; past this a copy settles as kept. */
export const LEGACY_SESSION_COPY_MAX_ASIDES = 16

/** Any aside of the copy holding bytes; a name that can't be checked counts as one. */
export async function hasMovedAsideCopy(copyPath: string): Promise<boolean> {
  for (let attempt = 1; attempt <= LEGACY_SESSION_COPY_MAX_ASIDES; attempt += 1) {
    const aside = await lstatIfPresent(
      `${copyPath}${LEGACY_SESSION_COPY_ASIDE_SUFFIX}.${attempt}`
    ).catch(() => ({ size: 1n }))
    if (aside && aside.size > 0n) {
      return true
    }
  }
  return false
}
