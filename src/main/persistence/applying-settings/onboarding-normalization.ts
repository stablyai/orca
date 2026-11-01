import type {
  OnboardingChecklistState,
  OnboardingOutcome,
  OnboardingState
} from '../../../shared/onboarding-state-types'
import type { NotificationSettings } from '../../../shared/notification-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getDefaultNotificationSettings } from '../../../shared/notification-settings-defaults'
import { normalizeVisibleExecutionHostIds } from '../../../shared/execution-host'
import {
  getDefaultOnboardingState,
  ONBOARDING_FINAL_STEP,
  ONBOARDING_FLOW_VERSION
} from '../../../shared/onboarding-defaults'

export function normalizeNotificationSettings(value: unknown): NotificationSettings {
  const defaults = getDefaultNotificationSettings()
  const candidate =
    value && typeof value === 'object' ? (value as Partial<NotificationSettings>) : {}
  const rawSoundId = (candidate as { customSoundId?: unknown }).customSoundId
  const customSoundId =
    rawSoundId === 'system' ||
    rawSoundId === 'two-tone' ||
    rawSoundId === 'bong' ||
    rawSoundId === 'thump' ||
    rawSoundId === 'blip' ||
    rawSoundId === 'sonar' ||
    rawSoundId === 'blop' ||
    rawSoundId === 'ding' ||
    rawSoundId === 'clack' ||
    rawSoundId === 'beep' ||
    rawSoundId === 'custom'
      ? rawSoundId
      : rawSoundId === 'orca' || rawSoundId === 'chime'
        ? 'two-tone'
        : rawSoundId === 'pop'
          ? 'blop'
          : typeof candidate.customSoundPath === 'string'
            ? 'custom'
            : defaults.customSoundId
  const rawVolume = candidate.customSoundVolume
  const customSoundVolume =
    typeof rawVolume === 'number' && Number.isFinite(rawVolume)
      ? Math.min(100, Math.max(0, rawVolume))
      : defaults.customSoundVolume
  // Validate fields individually: spreading disk JSON can admit truthy strings and invalid paths.
  const booleanOr = (raw: unknown, fallback: boolean): boolean =>
    typeof raw === 'boolean' ? raw : fallback
  return {
    enabled: booleanOr(candidate.enabled, defaults.enabled),
    agentTaskComplete: booleanOr(candidate.agentTaskComplete, defaults.agentTaskComplete),
    terminalBell: booleanOr(candidate.terminalBell, defaults.terminalBell),
    suppressWhenFocused: booleanOr(candidate.suppressWhenFocused, defaults.suppressWhenFocused),
    customSoundId,
    customSoundPath:
      typeof candidate.customSoundPath === 'string'
        ? candidate.customSoundPath
        : defaults.customSoundPath,
    customSoundVolume,
    mutedNotificationSourceIds: normalizeMutedNotificationSourceIds(
      candidate.mutedNotificationSourceIds
    ),
    notifyHiddenWorkspaces: booleanOr(
      candidate.notifyHiddenWorkspaces,
      defaults.notifyHiddenWorkspaces
    )
  }
}

function normalizeMutedNotificationSourceIds(
  raw: unknown
): NotificationSettings['mutedNotificationSourceIds'] {
  const strings = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === 'string')
    : null
  return normalizeVisibleExecutionHostIds(strings) ?? []
}

function sameNotificationSettingValue(raw: unknown, normalized: unknown): boolean {
  if (Array.isArray(normalized)) {
    return (
      Array.isArray(raw) &&
      raw.length === normalized.length &&
      raw.every((value, index) => value === normalized[index])
    )
  }
  return raw === normalized
}

/** Persist repairs so they do not repeat on launch; an absent block is not a repair. */
export function persistedNotificationSettingsRepaired(
  value: unknown,
  normalized: NotificationSettings
): boolean {
  if (value === undefined) {
    return false
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return true
  }
  const raw = value as Record<string, unknown>
  return Object.entries(normalized).some(
    ([key, normalizedValue]) => !sameNotificationSettingValue(raw[key], normalizedValue)
  )
}

export type SanitizeOnboardingUpdateOptions = {
  migrateLegacyProgress?: boolean
}

export function remapLegacyOnboardingLastCompletedStep(
  lastCompletedStep: number,
  raw: Record<string, unknown>
): number {
  if (raw.outcome === 'completed' && lastCompletedStep >= 4) {
    return ONBOARDING_FINAL_STEP
  }
  // v3 step 4 meant notifications, before the Windows terminal step was inserted.
  if (raw.flowVersion === 3) {
    return Math.min(4, lastCompletedStep)
  }
  // v2 step 4 was agent setup, before integrations replaced it.
  if (raw.flowVersion === 2) {
    if (lastCompletedStep === 3) {
      return 2
    }
    if (lastCompletedStep >= 4) {
      return 3
    }
    return lastCompletedStep
  }
  if (lastCompletedStep === 3) {
    return 2
  }
  if (lastCompletedStep === 4) {
    return 2
  }
  if (lastCompletedStep >= 5) {
    return 3
  }
  return lastCompletedStep
}

export function sanitizeOnboardingUpdate(
  input: unknown,
  options: SanitizeOnboardingUpdateOptions = {}
): Partial<Omit<OnboardingState, 'checklist'>> & { checklist?: Partial<OnboardingChecklistState> } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {}
  }
  const raw = input as Record<string, unknown>
  const out: Partial<Omit<OnboardingState, 'checklist'>> & {
    checklist?: Partial<OnboardingChecklistState>
  } = {}

  if ('closedAt' in raw) {
    // Nonfinite timestamps serialize to null and would reopen onboarding.
    if (typeof raw.closedAt === 'number' && Number.isFinite(raw.closedAt) && raw.closedAt >= 0) {
      out.closedAt = raw.closedAt
    } else if (raw.closedAt === null) {
      out.closedAt = null
    }
    // Invalid updates omit the field to preserve its saved value.
  }
  if ('outcome' in raw) {
    const v = raw.outcome
    if (v === 'completed' || v === 'dismissed') {
      out.outcome = v as OnboardingOutcome
    } else if (v === null) {
      out.outcome = null
    }
  }
  if ('flowVersion' in raw) {
    const v = raw.flowVersion
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= ONBOARDING_FLOW_VERSION) {
      out.flowVersion = v
    }
  }
  if ('lastCompletedStep' in raw) {
    const v = raw.lastCompletedStep
    if (typeof v === 'number' && Number.isInteger(v) && v >= -1) {
      const isLegacyFlow =
        options.migrateLegacyProgress && raw.flowVersion !== ONBOARDING_FLOW_VERSION
      // Migrate old step numbers before applying bounds for the shorter flow.
      const normalized = isLegacyFlow ? remapLegacyOnboardingLastCompletedStep(v, raw) : v
      if (normalized <= ONBOARDING_FINAL_STEP) {
        out.lastCompletedStep = normalized
      }
    }
  }
  if ('checklist' in raw) {
    const rawChecklist = raw.checklist
    if (rawChecklist && typeof rawChecklist === 'object' && !Array.isArray(rawChecklist)) {
      // Partial checklist updates must not reset omitted items.
      const defaults = getDefaultOnboardingState().checklist
      const rc = rawChecklist as Record<string, unknown>
      const checklist: Partial<OnboardingChecklistState> = {}
      for (const key of Object.keys(defaults) as (keyof OnboardingChecklistState)[]) {
        if (key in rc && typeof rc[key] === 'boolean') {
          checklist[key] = rc[key] as boolean
        }
      }
      out.checklist = checklist
    }
  }
  if (options.migrateLegacyProgress) {
    out.flowVersion = ONBOARDING_FLOW_VERSION
  }
  return out
}

export function normalizeLoadedOnboardingState(
  input: unknown,
  defaults: OnboardingState
): OnboardingState {
  // Existing files without onboarding state belong to upgrade users; skip the wizard.
  if (!input) {
    return {
      ...defaults,
      closedAt: Date.now(),
      outcome: 'completed',
      lastCompletedStep: ONBOARDING_FINAL_STEP
    }
  }
  const sanitized = sanitizeOnboardingUpdate(input, {
    migrateLegacyProgress: true
  })
  // Recover closure from the outcome so corrupt timestamps do not reopen onboarding.
  const recoveredClosedAt =
    typeof sanitized.closedAt === 'number'
      ? sanitized.closedAt
      : sanitized.outcome !== null && sanitized.outcome !== undefined
        ? Date.now()
        : sanitized.closedAt
  return {
    ...defaults,
    ...sanitized,
    closedAt: recoveredClosedAt ?? defaults.closedAt,
    checklist: {
      ...defaults.checklist,
      ...sanitized.checklist
    }
  }
}

export function resolveSetupGuideSidebarDismissedOnLoad(
  persistedDismissed: unknown,
  onboarding: OnboardingState
): boolean {
  // Once closed, a saved false is the old default, not a request to reopen the checklist.
  return onboarding.closedAt !== null || persistedDismissed === true
}

// Read the retired on-disk flag only for inline-agent migration.
export function readDeprecatedExperimentFlag(parsed: PersistedState | undefined): boolean {
  return (
    (parsed?.settings as { experimentalAgentDashboard?: boolean } | undefined)
      ?.experimentalAgentDashboard === true
  )
}

export function readLegacySidekickFlag(parsed: PersistedState | undefined): boolean | undefined {
  return (parsed?.settings as { experimentalSidekick?: boolean } | undefined)?.experimentalSidekick
}
