import { randomUUID } from 'node:crypto'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import {
  parseChatUiLaunchTipAudience,
  type ChatUiLaunchTipAudience
} from '../../../../shared/feature-education/chat-ui-launch-tip-audience'
import { carriedChatUiLaunchSettings } from '../../../../shared/native-chat/settings/native-chat-providers'
import { savedChatUiWithTerminalDefaultView } from '../../applying-settings/terminal-settings-migrations'

import type { StoreRuntimeState } from '../store-runtime-state'

type LoadedCohortMigrationOperationsRuntime = Pick<StoreRuntimeState, 'loadNeedsSave'>

export class LoadedCohortMigrationOperations {
  constructor(private readonly runtime: LoadedCohortMigrationOperationsRuntime) {}

  /** Freezes each rollout's new-or-existing cohort on first load, before a save makes a fresh install look existing. */
  migrateCohortSeeds(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    const existingProfile = fileExistedOnLoad && !isTelemetryOnlyProfile(state)
    for (const key of [
      'tabSwitchKeybindingSeed',
      'searchKeybindingSeed',
      'nonMacSearchKeybindingSeed'
    ] as const) {
      const existing = state.settings?.[key]
      if (existing === 'legacy' || existing === 'done') {
        continue
      }
      // Freeze each rollout's cohort before saving makes a fresh install appear existing.
      this.runtime.loadNeedsSave = true
      state = {
        ...state,
        settings: {
          ...state.settings,
          [key]: existing === 'pending' || existingProfile ? 'legacy' : 'done'
        }
      }
    }
    if (state.settings?.claudeCodeThemeSyncOffer === undefined) {
      this.runtime.loadNeedsSave = true
      // Why every profile: settings.json is global, so even a fresh profile must not restyle Claude Code unasked.
      state = {
        ...state,
        settings: {
          ...state.settings,
          claudeCodeThemeSync: false,
          claudeCodeThemeSyncOffer: 'pending'
        }
      }
    }
    return state
  }

  /** Reads the retired Chat UI switch from the raw profile, before load strips it. */
  captureChatUiLaunchTipAudience(savedProfile: unknown): ChatUiLaunchTipAudience {
    const saved = isRecord(savedProfile) ? savedProfile.chatUiLaunchTipAudience : undefined
    const kept = saved === undefined ? null : parseChatUiLaunchTipAudience(saved)
    if (kept) {
      return kept
    }
    // Persist this decision before later settings changes can alter the apparent audience.
    this.runtime.loadNeedsSave = true
    if (!isRecord(savedProfile)) {
      return { version: 1, membership: 'excluded', basis: 'new-profile' }
    }
    if (saved !== undefined) {
      // Never rederive a damaged audience record from current settings.
      return { version: 1, membership: 'excluded', basis: 'unreadable-record' }
    }
    const settings = isRecord(savedProfile.settings) ? savedProfile.settings : undefined
    // Opt-ins saved with new tabs opening in the terminal were kept on the terminal, so they count as off.
    const chatUiOn =
      settings?.experimentalNativeChat === true && !savedChatUiWithTerminalDefaultView(settings)
    return { version: 1, membership: 'eligible', basis: chatUiOn ? 'chat-ui-on' : 'chat-ui-off' }
  }

  /** Runs with the audience capture that first records the profile, so it applies once and in the same save. */
  carryChatUiChoices(
    state: PersistedState,
    savedProfile: unknown,
    audience: ChatUiLaunchTipAudience
  ): PersistedState {
    if (
      !isRecord(savedProfile) ||
      savedProfile.chatUiLaunchTipAudience !== undefined ||
      (audience.basis !== 'chat-ui-on' && audience.basis !== 'chat-ui-off')
    ) {
      return state
    }
    const saved = isRecord(savedProfile.settings) ? savedProfile.settings : undefined
    const launchSettings = carriedChatUiLaunchSettings(
      saved?.nativeChatProviders,
      audience.basis === 'chat-ui-on'
    )
    this.runtime.loadNeedsSave = true
    return { ...state, settings: { ...state.settings, ...launchSettings } }
  }

  /** Resume on restart defaults on for new profiles; profiles saved before without a choice keep it off. */
  keepResumeOnRestartOffForExistingProfiles(
    state: PersistedState,
    savedProfile: unknown
  ): PersistedState {
    if (!isRecord(savedProfile)) {
      return state
    }
    const saved = isRecord(savedProfile.settings) ? savedProfile.settings : undefined
    if (typeof saved?.nativeChatResumeWorkOnRestart === 'boolean') {
      return state
    }
    this.runtime.loadNeedsSave = true
    return { ...state, settings: { ...state.settings, nativeChatResumeWorkOnRestart: false } }
  }

  /** New cards are the default for new profiles; profiles saved before without a choice keep Classic. */
  seedWorktreeCardStyle(state: PersistedState, savedProfile: unknown): PersistedState {
    if (!isRecord(savedProfile) || isTelemetryOnlyProfile(savedProfile)) {
      // Why: a new profile starts on the new cards, so there is nothing to try or announce.
      this.runtime.loadNeedsSave = true
      return {
        ...state,
        ui: { ...state.ui, worktreeCardsIntroNoticeSeen: true, worktreeCardsUpdateNoticeSeen: true }
      }
    }
    const saved = isRecord(savedProfile.settings) ? savedProfile.settings : undefined
    if (typeof saved?.experimentalNewWorktreeCardStyle === 'boolean') {
      return state
    }
    this.runtime.loadNeedsSave = true
    return { ...state, settings: { ...state.settings, experimentalNewWorktreeCardStyle: false } }
  }

  migrateTelemetry(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    return this.seedMilestoneInstallCohort(
      this.migrateTelemetryIdentity(state, fileExistedOnLoad),
      fileExistedOnLoad
    )
  }

  /** Freeze once so upgraded profiles' first post-release interaction is never counted as activation. */
  private seedMilestoneInstallCohort(
    state: PersistedState,
    fileExistedOnLoad: boolean
  ): PersistedState {
    const telemetry = state.settings?.telemetry
    if (!telemetry || telemetry.protectedMilestones?.installCohort !== undefined) {
      return state
    }
    this.runtime.loadNeedsSave = true
    return {
      ...state,
      settings: {
        ...state.settings,
        telemetry: {
          ...telemetry,
          protectedMilestones: {
            ...telemetry.protectedMilestones,
            installCohort: fileExistedOnLoad ? 'existing' : 'fresh'
          }
        }
      }
    }
  }

  private migrateTelemetryIdentity(
    state: PersistedState,
    fileExistedOnLoad: boolean
  ): PersistedState {
    const existing = state.settings?.telemetry
    // Partial telemetry blocks still require migration unless all invariants hold.
    if (
      typeof existing?.existedBeforeTelemetryRelease === 'boolean' &&
      typeof existing.installId === 'string' &&
      existing.installId.length > 0 &&
      (existing.optedIn === true || existing.optedIn === false || existing.optedIn === null)
    ) {
      return state
    }
    const resolvedExistedBefore =
      typeof existing?.existedBeforeTelemetryRelease === 'boolean'
        ? existing.existedBeforeTelemetryRelease
        : fileExistedOnLoad
    this.runtime.loadNeedsSave = true
    return {
      ...state,
      settings: {
        ...state.settings,
        telemetry: {
          ...existing,
          existedBeforeTelemetryRelease: resolvedExistedBefore,
          // Preserve explicit true, false and null; only absence uses the cohort default.
          optedIn:
            existing?.optedIn === true || existing?.optedIn === false || existing?.optedIn === null
              ? existing.optedIn
              : resolvedExistedBefore
                ? null
                : true,
          installId:
            typeof existing?.installId === 'string' && existing.installId.length > 0
              ? existing.installId
              : randomUUID()
        }
      }
    }
  }
}

/** Secondary profiles start with only the install's telemetry consent, before their first load. */
function isTelemetryOnlyProfile(profile: unknown): boolean {
  const settings = isRecord(profile) ? profile.settings : undefined
  return (
    isRecord(profile) &&
    Object.keys(profile).length === 1 &&
    isRecord(settings) &&
    Object.keys(settings).length === 1 &&
    isRecord(settings.telemetry)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
