import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { OnboardingChecklistState } from '../../../shared/onboarding-state-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getDefaultOnboardingState } from '../../../shared/onboarding-defaults'
import type { FeatureInteractionId } from '../../../shared/feature-interactions'
import {
  nativeChatUpgradeTipVariant,
  parseNativeChatUpgradeTipAudience,
  type NativeChatUpgradeTipVariant
} from '../../../shared/native-chat-upgrade-tip-audience'
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
import { bumpLocalWorktreeScanGeneration } from '../../local-worktree-scan-generation'

type ProfilePreferencesRuntime = Pick<
  StoreRuntimeState,
  | 'activeViewPreference'
  | 'githubCacheDirty'
  | 'githubCacheGeneration'
  | 'protectedSecrets'
  | 'runDurableMutation'
  | 'settingsChangeListeners'
  | 'state'
  | 'uiChangeListeners'
>

const profilePreferencesContext = Symbol('ProfilePreferences')
type ProfilePreferencesContext = {
  runtime: ProfilePreferencesRuntime
  scheduling: WriteSchedulingOperations
  settingsWriteOwners: Map<string, symbol>
}

export class ProfilePreferences {
  readonly [profilePreferencesContext]: ProfilePreferencesContext

  constructor(runtime: ProfilePreferencesRuntime, scheduling: WriteSchedulingOperations) {
    this[profilePreferencesContext] = { runtime, scheduling, settingsWriteOwners: new Map() }
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

  async updateSettingsAndFlush(
    updates: Partial<GlobalSettings>,
    options: { notifyListeners?: boolean; originWebContentsId?: number } = {}
  ): Promise<GlobalSettings> {
    const { runtime, settingsWriteOwners } = this[profilePreferencesContext]
    let changedUpdates: Partial<GlobalSettings> = {}
    let rollbackKeys: readonly string[] | undefined
    let writeOwners = new Map<string, symbol | undefined>()
    await runtime
      .runDurableMutation(() => {
        const previous = runtime.state.settings
        const next = this.updateSettings(updates)
        const previousEntries = new Map(Object.entries(previous))
        const updateKeys = new Set(Object.keys(updates))
        if (previous.terminalLinkActionPopoverEnabled !== next.terminalLinkActionPopoverEnabled) {
          // Keep the legacy switch inside the click choice's durability boundary.
          updateKeys.add('terminalLinkActionPopoverEnabled')
        }
        changedUpdates = Object.fromEntries(
          Object.entries(next).filter(
            ([key, value]) => updateKeys.has(key) && !Object.is(previousEntries.get(key), value)
          )
        )
        writeOwners = new Map([...updateKeys].map((key) => [key, settingsWriteOwners.get(key)]))
        return {
          value: undefined,
          rollback: () => {
            const currentEntries = new Map(Object.entries(runtime.state.settings))
            const nextEntries = new Map(Object.entries(next))
            // Same-value writes still own their choice; failed predecessors cannot restore over them.
            const stillOwned = (key: string): boolean =>
              settingsWriteOwners.get(key) === writeOwners.get(key)
            const restoredUpdates = Object.fromEntries(
              Object.entries(previous).filter(
                ([key]) =>
                  updateKeys.has(key) &&
                  stillOwned(key) &&
                  Object.is(currentEntries.get(key), nextEntries.get(key))
              )
            )
            const restoredSettings = { ...runtime.state.settings, ...restoredUpdates }
            for (const key of updateKeys) {
              if (
                !previousEntries.has(key) &&
                stillOwned(key) &&
                Object.is(currentEntries.get(key), nextEntries.get(key))
              ) {
                Reflect.deleteProperty(restoredSettings, key)
              }
            }
            runtime.state.settings = restoredSettings
            if (options.notifyListeners && [...updateKeys].some((key) => !stillOwned(key))) {
              rollbackKeys = [...updateKeys]
            }
          }
        }
      })
      .catch((error) => {
        if (rollbackKeys) {
          try {
            const currentEntries = new Map(Object.entries(runtime.state.settings))
            notifySettingsChanged(
              this,
              Object.fromEntries(rollbackKeys.map((key) => [key, currentEntries.get(key)]))
            )
          } catch (notificationError) {
            console.warn('[persistence] Failed to publish restored settings:', notificationError)
          }
        }
        throw error
      })
    if (options.notifyListeners) {
      const currentEntries = new Map(Object.entries(runtime.state.settings))
      const currentUpdates = Object.fromEntries(
        Object.entries(changedUpdates).filter(([key, value]) =>
          Object.is(currentEntries.get(key), value)
        )
      )
      if (Object.keys(currentUpdates).length > 0) {
        notifySettingsChanged(this, currentUpdates, options.originWebContentsId)
      }
    }
    return this.getSettings()
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

  /** Fails closed: a missing or damaged record reads as no tip. */
  getNativeChatUpgradeTipVariant(): NativeChatUpgradeTipVariant {
    return nativeChatUpgradeTipVariant(
      parseNativeChatUpgradeTipAudience(
        this[profilePreferencesContext].runtime.state.nativeChatUpgradeTipAudience
      )
    )
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
    bumpLocalWorktreeScanGeneration,
    removeRetainedBlob: (slot) =>
      owner[profilePreferencesContext].runtime.protectedSecrets.removeRetainedBlob(slot),
    scheduleSave: () => scheduleSave(owner[profilePreferencesContext].scheduling, ['settings']),
    recordSettingsWrite: (keys) => {
      const writeOwner = Symbol('settings write')
      for (const key of keys) {
        owner[profilePreferencesContext].settingsWriteOwners.set(key, writeOwner)
      }
    },
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
    scheduleSave: (domains) => scheduleSave(owner[profilePreferencesContext].scheduling, domains),
    notifyUIChanged: () => notifyUIChanged(owner),
    getUI: () => owner.getUI()
  }
}
