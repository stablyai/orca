import { randomUUID } from 'node:crypto'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  createNewProfileNativeChatUpgradeTipAudience,
  parseNativeChatUpgradeTipAudience,
  type NativeChatUpgradeTipAudience
} from '../../../shared/native-chat-upgrade-tip-audience'

import type { StoreRuntimeState } from './store-runtime-state'

type LoadedCohortMigrationOperationsRuntime = Pick<StoreRuntimeState, 'loadNeedsSave'>

export class LoadedCohortMigrationOperations {
  constructor(private readonly runtime: LoadedCohortMigrationOperationsRuntime) {}

  migrateTabSwitchKeybindings(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    const existing = state.settings?.tabSwitchKeybindingSeed
    if (existing === 'pending' || existing === 'done') {
      return state
    }
    // Why: mark dirty so the frozen cohort persists; else a fresh install re-reads as "existing" after its file lands.
    this.runtime.loadNeedsSave = true
    return {
      ...state,
      settings: {
        ...state.settings,
        // Existing installs pin old chords via a keybindings.json seed; fresh installs use the new registry defaults.
        tabSwitchKeybindingSeed: fileExistedOnLoad ? 'pending' : 'done'
      }
    }
  }

  /** Keeps the saved record, or decides it once from the profile as saved before this build ran. */
  captureNativeChatUpgradeTipAudience(savedProfile: unknown): NativeChatUpgradeTipAudience {
    const saved = isRecord(savedProfile) ? savedProfile.nativeChatUpgradeTipAudience : undefined
    const kept = saved === undefined ? null : parseNativeChatUpgradeTipAudience(saved)
    if (kept) {
      return kept
    }
    // Why: persist the decision now; a later settings-only write would leave a recaptured live switch.
    this.runtime.loadNeedsSave = true
    if (!isRecord(savedProfile)) {
      return createNewProfileNativeChatUpgradeTipAudience()
    }
    if (saved !== undefined) {
      // Why: fail closed; a damaged record must never be re-derived from today's Chat UI switch.
      return { version: 1, membership: 'excluded', basis: 'unreadable-record' }
    }
    const settings = isRecord(savedProfile.settings) ? savedProfile.settings : undefined
    const chatUi = settings?.experimentalNativeChat
    if (chatUi === true) {
      // Why: every build before the chat upgrade saved this key and the upgrade strips it, so
      // without it the opt-in may postdate the upgrade and cannot prove membership.
      return settings && Object.hasOwn(settings, 'openAgentTabsInChatByDefault')
        ? { version: 1, membership: 'eligible', basis: 'chat-ui-on' }
        : { version: 1, membership: 'excluded', basis: 'chat-ui-on-unproven' }
    }
    return {
      version: 1,
      membership: 'excluded',
      basis: chatUi === false ? 'chat-ui-off' : 'chat-ui-unset'
    }
  }

  migrateTelemetry(state: PersistedState, fileExistedOnLoad: boolean): PersistedState {
    const existing = state.settings?.telemetry
    // Why: require all three invariants; keying on existedBeforeTelemetryRelease alone lets a partial block skip migration.
    if (
      typeof existing?.existedBeforeTelemetryRelease === 'boolean' &&
      typeof existing.installId === 'string' &&
      existing.installId.length > 0 &&
      (existing.optedIn === true || existing.optedIn === false || existing.optedIn === null)
    ) {
      return state
    }
    // Why: resolve cohort once; re-inferring it in the optedIn fallback could misclassify a partially-written new user.
    const resolvedExistedBefore =
      typeof existing?.existedBeforeTelemetryRelease === 'boolean'
        ? existing.existedBeforeTelemetryRelease
        : fileExistedOnLoad
    return {
      ...state,
      settings: {
        ...state.settings,
        telemetry: {
          ...existing,
          existedBeforeTelemetryRelease: resolvedExistedBefore,
          // Why: preserve any explicit opt-in/out; fall back to cohort default only when optedIn is undefined, never when false.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
