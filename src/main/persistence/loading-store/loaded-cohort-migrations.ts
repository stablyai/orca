import { randomUUID } from 'node:crypto'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  classifyNativeChatGraduationCohort,
  isNativeChatGraduationCohort
} from '../../../shared/native-chat-graduation-cohort'

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

  /** `savedExperimentalNativeChat` must be read from the parsed file before defaults fill it in. */
  migrateNativeChatGraduationCohort(
    state: PersistedState,
    fileExistedOnLoad: boolean,
    savedExperimentalNativeChat: unknown
  ): PersistedState {
    const existing: unknown = state.settings?.nativeChatGraduationCohort
    if (isNativeChatGraduationCohort(existing)) {
      return state
    }
    // Why: once classified (even malformed), never re-read the live toggle; post-graduation users
    // can turn Chat UI on, so re-deriving would admit them. Dirty so the first save pins it.
    this.runtime.loadNeedsSave = true
    return {
      ...state,
      settings: {
        ...state.settings,
        nativeChatGraduationCohort:
          existing === undefined
            ? classifyNativeChatGraduationCohort({ fileExistedOnLoad, savedExperimentalNativeChat })
            : 'other'
      }
    }
  }
}
