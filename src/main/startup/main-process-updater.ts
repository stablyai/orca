import { preserveAgentAuthBeforeRestart } from '../agent-auth-restart-preservation'
import { resolveUpdateInstallMode } from '../updater'
import {
  configureProfileAutoUpdater,
  type ProfileAutoUpdaterOptions
} from '../updater/profile-auto-updater'
import { mainProcessState as state } from './main-process-state'

export function getMainProcessUpdaterOptions(): ProfileAutoUpdaterOptions {
  const { store, codexRuntimeHome, claudeRuntimeAuth } = state
  if (!store || !codexRuntimeHome || !claudeRuntimeAuth) {
    throw new Error('Profile and auth services must be initialized before the updater')
  }
  return {
    onBeforeUpdateQuit: async () => {
      await preserveAgentAuthBeforeRestart({ codexRuntimeHome, claudeRuntimeAuth, store })
      await store.writeLatestProfileStateJsonCompatibilityExportAsync()
    },
    onBeforeUpdateQuitFailure: 'abort',
    updateInstallMode: resolveUpdateInstallMode(state.isServeMode)
  }
}

export function configureServeAutoUpdater(): void {
  const options = getMainProcessUpdaterOptions()
  if (!state.store) {
    throw new Error('Profile store must be initialized before the updater')
  }
  configureProfileAutoUpdater(null, state.store, options)
}
