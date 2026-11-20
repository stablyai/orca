import { basename, join } from 'node:path'
import {
  LEGACY_SESSION_COPY_ASIDE_SUFFIX,
  LEGACY_SESSION_COPY_MAX_ASIDES
} from '../bridges/codex-legacy-session-copy'
import type { RolloutName } from './codex-rollout-permanent-delete'

/** An old session copy's own bytes, kept beside the name once its source was linked in. */
export function legacyCopyAsideNames(homes: readonly string[], stem: string): RolloutName[] {
  const parts = stem.split('/')
  const names: RolloutName[] = []
  for (const home of homes) {
    const sessions = join(home, 'sessions')
    const base = `${join(sessions, ...parts)}${LEGACY_SESSION_COPY_ASIDE_SUFFIX}`
    for (let attempt = 1; attempt <= LEGACY_SESSION_COPY_MAX_ASIDES; attempt += 1) {
      // Every number: a cleanup that stopped partway may have left a gap below a later one.
      names.push({ path: `${base}.${attempt}`, root: sessions })
    }
    names.push({ path: `${base}.probe`, root: sessions })
  }
  return names
}

/** A swap's empty reservation or probe: it holds no chat, so it never decides a deletion. */
export function isEmptyLegacyCopyName(path: string, size: number): boolean {
  return size === 0 && basename(path).includes(`${LEGACY_SESSION_COPY_ASIDE_SUFFIX}.`)
}
