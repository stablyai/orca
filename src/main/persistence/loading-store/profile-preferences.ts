import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { OnboardingChecklistState } from '../../../shared/onboarding-state-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getDefaultOnboardingState } from '../../../shared/constants'
import type { FeatureInteractionId } from '../../../shared/feature-interactions'
import {
  updateSettings as updateSettingsOperation,
  type SettingsMutationOperations
} from '../applying-settings/settings-update'
import { getPersistedUI } from '../applying-settings/ui-state-read'
import { updatePersistedUI, type UIUpdateOperations } from '../applying-settings/ui-state-update'
import {
  recordFeatureInteraction as recordFeatureInteractionOperation,
  type FeatureInteractionOperations
} from '../applying-settings/feature-interaction-recording'

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type ProfilePreferencesRuntime = Pick<
  StoreRuntimeState,
  | 'activeViewPreference'
  | 'githubCacheDirty'
  | 'githubCacheGeneration'
  | 'protectedSecrets'
  | 'settingsChangeListeners'
  | 'state'
  | 'uiChangeListeners'
>

const profilePreferencesContext = Symbol('ProfilePreferences')
type ProfilePreferencesContext = {
  runtime: ProfilePreferencesRuntime
  scheduling: WriteSchedulingOperations
}

export class ProfilePreferences {
  readonly [profilePreferencesContext]: ProfilePreferencesContext

  constructor(runtime: ProfilePreferencesRuntime, scheduling: WriteSchedulingOperations) {
    this[profilePreferencesContext] = { runtime, scheduling }
  }

  getSettings(): GlobalSettings {
    return this[profilePreferencesContext].runtime.state.settings
  }

  onSettingsChanged(
    listener: (
      updates: Partial<GlobalSettings>,
      settings: GlobalSettings,
      originWebContentsId?: number
    ) => void
  ): () => void {
    this[profilePreferencesContext].runtime.settingsChangeListeners.add(listener)
    return () => {
      this[profilePreferencesContext].runtime.settingsChangeListeners.delete(listener)
    }
  }

  onUIChanged(listener: (ui: PersistedState['ui']) => void): () => void {
    this[profilePreferencesContext].runtime.uiChangeListeners.add(listener)
    return () => {
      this[profilePreferencesContext].runtime.uiChangeListeners.delete(listener)
    }
  }

  updateSettings(
    updates: Partial<GlobalSettings>,
    options: { notifyListeners?: boolean; originWebContentsId?: number } = {}
  ): GlobalSettings {
    return updateSettingsOperation(getSettingsMutationOperations(this), updates, options)
  }

  getUI(): PersistedState['ui'] {
    return getPersistedUI(
      this[profilePreferencesContext].runtime.state,
      this[profilePreferencesContext].runtime.activeViewPreference.get()
    )
  }

  updateUI(updates: Partial<PersistedState['ui']>): void {
    updatePersistedUI(getUIUpdateOperations(this), updates)
  }

  recordFeatureInteraction(id: FeatureInteractionId): PersistedState['ui'] {
    return recordFeatureInteractionOperation(getFeatureInteractionOperations(this), id)
  }

  getOnboarding(): PersistedState['onboarding'] {
    const defaults = getDefaultOnboardingState()
    return {
      ...defaults,
      ...this[profilePreferencesContext].runtime.state.onboarding,
      checklist: {
        ...defaults.checklist,
        ...this[profilePreferencesContext].runtime.state.onboarding?.checklist
      }
    }
  }

  updateOnboarding(
    updates: Partial<Omit<PersistedState['onboarding'], 'checklist'>> & {
      checklist?: Partial<OnboardingChecklistState>
    }
  ): PersistedState['onboarding'] {
    const current = this.getOnboarding()
    this[profilePreferencesContext].runtime.state.onboarding = {
      ...current,
      ...updates,
      checklist: {
        ...current.checklist,
        ...updates.checklist
      }
    }
    scheduleSave(this[profilePreferencesContext].scheduling)
    return this.getOnboarding()
  }

  getGitHubCache(): PersistedState['githubCache'] {
    return this[profilePreferencesContext].runtime.state.githubCache
  }

  setGitHubCache(cache: PersistedState['githubCache']): void {
    // Why no scheduleSave: cache is memory-only and snapshotted to a sidecar at flush; persisting here rewrote the whole state file every poll cycle.
    this[profilePreferencesContext].runtime.state.githubCache = cache
    this[profilePreferencesContext].runtime.githubCacheDirty = true
    this[profilePreferencesContext].runtime.githubCacheGeneration += 1
  }
}

export function notifySettingsChanged(
  owner: ProfilePreferences,
  updates: Partial<GlobalSettings>,
  originWebContentsId?: number
): void {
  for (const listener of owner[profilePreferencesContext].runtime.settingsChangeListeners) {
    listener(updates, owner[profilePreferencesContext].runtime.state.settings, originWebContentsId)
  }
}

export function notifyUIChanged(owner: ProfilePreferences): void {
  if (owner[profilePreferencesContext].runtime.uiChangeListeners.size === 0) {
    return
  }
  const ui = owner.getUI()
  for (const listener of owner[profilePreferencesContext].runtime.uiChangeListeners) {
    listener(ui)
  }
}

export function getSettingsMutationOperations(
  owner: ProfilePreferences
): SettingsMutationOperations {
  return {
    state: owner[profilePreferencesContext].runtime.state,
    removeRetainedBlob: (slot) =>
      owner[profilePreferencesContext].runtime.protectedSecrets.removeRetainedBlob(slot),
    scheduleSave: () => scheduleSave(owner[profilePreferencesContext].scheduling),
    notifySettingsChanged: (updates, originWebContentsId) =>
      notifySettingsChanged(owner, updates, originWebContentsId)
  }
}

export function getUIUpdateOperations(owner: ProfilePreferences): UIUpdateOperations {
  return {
    state: owner[profilePreferencesContext].runtime.state,
    removeRetainedBlob: (slot) =>
      owner[profilePreferencesContext].runtime.protectedSecrets.removeRetainedBlob(slot),
    setActiveView: (activeView) =>
      owner[profilePreferencesContext].runtime.activeViewPreference.set(activeView),
    getUI: () => owner.getUI(),
    scheduleSave: () => scheduleSave(owner[profilePreferencesContext].scheduling),
    notifyUIChanged: () => notifyUIChanged(owner)
  }
}

export function getFeatureInteractionOperations(
  owner: ProfilePreferences
): FeatureInteractionOperations {
  return {
    state: owner[profilePreferencesContext].runtime.state,
    scheduleSave: () => scheduleSave(owner[profilePreferencesContext].scheduling),
    notifyUIChanged: () => notifyUIChanged(owner),
    getUI: () => owner.getUI()
  }
}

export function installProfilePreferencesContext(target: object, source: ProfilePreferences): void {
  Object.defineProperty(target, profilePreferencesContext, {
    value: source[profilePreferencesContext]
  })
}
