import type {
  OnboardingChecklistState,
  OnboardingOutcome,
  OnboardingState
} from '../../../shared/onboarding-state-types'
import type { NotificationSettings } from '../../../shared/notification-settings-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  getDefaultNotificationSettings,
  getDefaultOnboardingState,
  ONBOARDING_FINAL_STEP,
  ONBOARDING_FLOW_VERSION
} from '../../../shared/constants'

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
  // Why field-by-field: a blanket spread let a type-flipped value on disk through, so `enabled: "false"`
  // stayed truthy and `customSoundPath: 42` reached the sound loader.
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
    customSoundVolume
  }
}

/**
 * Whether normalization had to repair the persisted notification block. Callers use this to mark the
 * load dirty; an in-memory-only repair is redone on every launch until some other write lands.
 * A missing block is not a repair — nothing on disk was overridden.
 */
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
  return Object.entries(normalized).some(([key, normalizedValue]) => raw[key] !== normalizedValue)
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
  // Why: v3 (pre-Windows-terminal-page) step 4 already meant notifications, so resume there, not the inserted Windows step.
  if (raw.flowVersion === 3) {
    return Math.min(4, lastCompletedStep)
  }
  // Why: v2's five-step flow had step 4 = removed agent setup, not completed integrations.
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
    // Why: NaN/Infinity serialize to null on save, reverting closedAt and reopening the wizard; require a finite timestamp.
    if (typeof raw.closedAt === 'number' && Number.isFinite(raw.closedAt) && raw.closedAt >= 0) {
      out.closedAt = raw.closedAt
    } else if (raw.closedAt === null) {
      out.closedAt = null
    }
    // else: omit — preserve existing persisted value on merge.
  }
  if ('outcome' in raw) {
    const v = raw.outcome
    if (v === 'completed' || v === 'dismissed') {
      out.outcome = v as OnboardingOutcome
    } else if (v === null) {
      out.outcome = null
    }
    // else: omit.
  }
  if ('flowVersion' in raw) {
    const v = raw.flowVersion
    if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= ONBOARDING_FLOW_VERSION) {
      out.flowVersion = v
    }
    // else: omit.
  }
  if ('lastCompletedStep' in raw) {
    const v = raw.lastCompletedStep
    if (typeof v === 'number' && Number.isInteger(v) && v >= -1) {
      const isLegacyFlow =
        options.migrateLegacyProgress && raw.flowVersion !== ONBOARDING_FLOW_VERSION
      // Why: removing two wizard pages changed step numbering; migrate legacy values before the final-step bound drops them.
      const normalized = isLegacyFlow ? remapLegacyOnboardingLastCompletedStep(v, raw) : v
      if (normalized <= ONBOARDING_FINAL_STEP) {
        out.lastCompletedStep = normalized
      }
    }
    // else: omit.
  }
  if ('checklist' in raw) {
    const rawChecklist = raw.checklist
    if (rawChecklist && typeof rawChecklist === 'object' && !Array.isArray(rawChecklist)) {
      // Why: copy ONLY caller-sent boolean keys so partial updates don't reset other checklist items to false.
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
  // Why: an existing file with no onboarding block is an upgrade user; backfill as completed so they skip the wizard.
  if (!input) {
    return {
      ...defaults,
      closedAt: Date.now(),
      outcome: 'completed',
      lastCompletedStep: ONBOARDING_FINAL_STEP
    }
  }
  // Why: sanitize persisted onboarding keys so a type-flipped field on disk can't poison in-memory state.
  const sanitized = sanitizeOnboardingUpdate(input, {
    migrateLegacyProgress: true
  })
  // Why: a completed/dismissed outcome means the user left; recover a bad closedAt instead of reopening the checklist.
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
  // Why: once onboarding is closed, persisted false is just the old default, not a user opt-in to the sidebar checklist.
  return onboarding.closedAt !== null || persistedDismissed === true
}

// Why: read a settings field removed from GlobalSettings but still on disk; one-shot for the inline-agents migration.
export function readDeprecatedExperimentFlag(parsed: PersistedState | undefined): boolean {
  return (
    (parsed?.settings as { experimentalAgentDashboard?: boolean } | undefined)
      ?.experimentalAgentDashboard === true
  )
}

export function readLegacySidekickFlag(parsed: PersistedState | undefined): boolean | undefined {
  return (parsed?.settings as { experimentalSidekick?: boolean } | undefined)?.experimentalSidekick
}
