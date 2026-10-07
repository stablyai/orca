import {
  DEFAULT_LINEAGE_DISCOVERY,
  type LineageDiscoverySettings,
  type LineagePatternMatchOn
} from '../../shared/lineage-discovery-types'

const MATCH_ON: readonly string[] = ['branch', 'worktree-name', 'both']

function isMatchOn(value: unknown): value is LineagePatternMatchOn {
  return typeof value === 'string' && MATCH_ON.includes(value)
}

function isRepoScope(value: unknown): value is 'all' | string[] {
  return value === 'all' || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
}

/** hazard: persisted settings are not shape-validated on load, so every field is type-checked here. */
export function resolveEffectiveDiscoverySettings(stored: unknown): LineageDiscoverySettings {
  const defaults = DEFAULT_LINEAGE_DISCOVERY
  if (typeof stored !== 'object' || stored === null) {
    return { ...defaults }
  }
  const raw: Record<string, unknown> = { ...stored }
  return {
    lineageEnabled:
      typeof raw.lineageEnabled === 'boolean' ? raw.lineageEnabled : defaults.lineageEnabled,
    patternEnabled:
      typeof raw.patternEnabled === 'boolean' ? raw.patternEnabled : defaults.patternEnabled,
    keyRegex: typeof raw.keyRegex === 'string' ? raw.keyRegex : defaults.keyRegex,
    matchOn: isMatchOn(raw.matchOn) ? raw.matchOn : defaults.matchOn,
    repoScope: isRepoScope(raw.repoScope) ? raw.repoScope : defaults.repoScope
  }
}
