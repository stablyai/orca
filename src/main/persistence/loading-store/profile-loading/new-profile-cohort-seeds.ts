import { homedir } from 'node:os'
import { getDefaultPersistedState } from '../../../../shared/orca-profiles/constants'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'

/** What the first load would seed for a new profile; writers that run before it must seed the same. */
export const NEW_PROFILE_COHORT_SEEDS = {
  nativeChatMarkNewMessages: false,
  floatingWorkspaceInSettings: false
} as const satisfies Partial<GlobalSettings>

/** Secondary profiles start with only the install's telemetry consent, before their first load. */
export function isTelemetryOnlyProfile(profile: unknown): boolean {
  const settings = isRecord(profile) ? profile.settings : undefined
  return (
    isRecord(profile) &&
    Object.keys(profile).length === 1 &&
    isRecord(settings) &&
    Object.keys(settings).length === 1 &&
    isRecord(settings.telemetry)
  )
}

export function newProfileSeededState(): PersistedState {
  const defaults = getDefaultPersistedState(homedir())
  return { ...defaults, settings: { ...defaults.settings, ...NEW_PROFILE_COHORT_SEEDS } }
}

/** Seeds a telemetry-only root as new; any other root keeps its bytes and loads as existing. */
export function seedTelemetryOnlyProfileJson(rawJson: string): string {
  let root: unknown
  try {
    root = JSON.parse(rawJson)
  } catch {
    return rawJson
  }
  if (!isTelemetryOnlyProfile(root) || !isRecord(root)) {
    return rawJson
  }
  const settings = isRecord(root.settings) ? root.settings : {}
  return JSON.stringify({ ...root, settings: { ...settings, ...NEW_PROFILE_COHORT_SEEDS } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
