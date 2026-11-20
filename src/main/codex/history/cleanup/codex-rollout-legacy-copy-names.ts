import { lstat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import {
  LEGACY_SESSION_COPY_ASIDE_SUFFIX,
  LEGACY_SESSION_COPY_MAX_ASIDES
} from '../bridges/codex-legacy-session-copy'
import type { RolloutName } from './codex-rollout-permanent-delete'

/**
 * An old session copy's own bytes, kept beside the name once its source was linked in. Swaps number
 * them from 1 and never remove one, so counting up to the first gap finds them all.
 */
export async function legacyCopyAsideNames(
  homes: readonly string[],
  stem: string
): Promise<RolloutName[]> {
  const parts = stem.split('/')
  const names: RolloutName[] = []
  for (const home of homes) {
    const sessions = join(home, 'sessions')
    const base = `${join(sessions, ...parts)}${LEGACY_SESSION_COPY_ASIDE_SUFFIX}`
    for (let attempt = 1; attempt <= LEGACY_SESSION_COPY_MAX_ASIDES; attempt += 1) {
      const name = { path: `${base}.${attempt}`, root: sessions }
      if (
        !(await lstat(name.path).then(
          () => true,
          (error: unknown) => !isDefinitiveAbsence(error)
        ))
      ) {
        break
      }
      names.push(name)
    }
    names.push({ path: `${base}.probe`, root: sessions })
  }
  return names
}

/** A swap's empty reservation or probe: it holds no chat, so it never decides a deletion. */
export function isEmptyLegacyCopyName(path: string, size: number): boolean {
  return size === 0 && basename(path).includes(`${LEGACY_SESSION_COPY_ASIDE_SUFFIX}.`)
}
