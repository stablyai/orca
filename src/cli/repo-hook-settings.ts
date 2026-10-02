import { getDefaultRepoHookSettings } from '../shared/constants'
import type {
  HookCommandSourcePolicy,
  RepoHookSettings,
  SetupAgentStartupPolicy,
  SetupRunPolicy
} from '../shared/orca-yaml-hook-types'

export type RepoHookSettingsChange = {
  setupScript?: string
  archiveScript?: string
  setupRunPolicy?: SetupRunPolicy
  setupAgentStartupPolicy?: SetupAgentStartupPolicy
  commandSourcePolicy?: HookCommandSourcePolicy
}

export const SETUP_RUN_POLICIES: readonly SetupRunPolicy[] = [
  'ask',
  'run-by-default',
  'skip-by-default'
]
export const SETUP_AGENT_STARTUP_POLICIES: readonly SetupAgentStartupPolicy[] = [
  'start-immediately',
  'wait-for-setup'
]
export const HOOK_COMMAND_SOURCE_POLICIES: readonly HookCommandSourcePolicy[] = [
  'shared-only',
  'local-only',
  'run-both'
]

/**
 * `store.updateRepo` replaces `hookSettings` wholesale, so a partial CLI edit has to be
 * rebased on what the repo already has, exactly like the settings pane's draft.
 */
export function mergeRepoHookSettings(
  current: RepoHookSettings | undefined,
  change: RepoHookSettingsChange
): RepoHookSettings {
  const defaults = getDefaultRepoHookSettings()
  return {
    ...defaults,
    ...current,
    ...(change.setupRunPolicy ? { setupRunPolicy: change.setupRunPolicy } : {}),
    ...(change.setupAgentStartupPolicy
      ? { setupAgentStartupPolicy: change.setupAgentStartupPolicy }
      : {}),
    ...(change.commandSourcePolicy ? { commandSourcePolicy: change.commandSourcePolicy } : {}),
    scripts: {
      ...defaults.scripts,
      ...current?.scripts,
      ...(change.setupScript === undefined ? {} : { setup: change.setupScript }),
      ...(change.archiveScript === undefined ? {} : { archive: change.archiveScript })
    }
  }
}

export function hasRepoHookSettingsChange(change: RepoHookSettingsChange): boolean {
  return Object.values(change).some((value) => value !== undefined)
}
