import { basename, join } from 'node:path'
import {
  LEGACY_SESSION_COPY_ASIDE_SUFFIX,
  LEGACY_SESSION_COPY_MAX_ASIDES
} from '../bridges/codex-legacy-session-copy'
import type { RolloutName } from './codex-rollout-names'

/**
 * An old session copy's own bytes, kept beside the name once its source was linked in. Only
 * Orca's runtime home ever held legacy copies, so no other home is searched.
 */
export function legacyCopyAsideNames(managedHome: string, stem: string): RolloutName[] {
  const sessions = join(managedHome, 'sessions')
  const base = `${join(sessions, ...stem.split('/'))}${LEGACY_SESSION_COPY_ASIDE_SUFFIX}`
  const names: RolloutName[] = []
  for (let attempt = 1; attempt <= LEGACY_SESSION_COPY_MAX_ASIDES; attempt += 1) {
    // Every number: a cleanup that stopped partway may have left a gap below a later one.
    names.push({ path: `${base}.${attempt}`, root: sessions })
  }
  names.push({ path: `${base}.probe`, root: sessions })
  return names
}

/** A swap's empty reservation or probe: it holds no chat, so it never decides a deletion. */
export function isEmptyLegacyCopyName(path: string, size: number): boolean {
  return size === 0 && basename(path).includes(`${LEGACY_SESSION_COPY_ASIDE_SUFFIX}.`)
}
