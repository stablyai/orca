import type { AgentHookInstallState } from '../../shared/agent-hook-listener/configuration/agent-hook-types'
import type { HookDefinition } from '../agent-hooks/installation/configuration/hook-config-schema'
import { isPlainObject } from '../agent-hooks/installation/configuration/hooks-json-read'
import { DROID_EVENTS, type DroidHookFiles } from './droid-hook-config'

const HOOKS_DISABLED_DETAIL = 'Droid hooks are disabled in Factory settings'
const ORG_MANAGED_ONLY_DETAIL =
  'Droid ignores user hooks because your organization allows managed hooks only'

/** The entries Droid loads for one event: a hooks.json event replaces the settings.json one. */
function loadedDefinitions(files: DroidHookFiles, eventName: string): HookDefinition[] {
  const fromHooksJson = files.hooksFile[eventName]
  if (Array.isArray(fromHooksJson)) {
    return fromHooksJson
  }
  const settingsHooks: unknown = files.settings.hooks
  const fromSettings = isPlainObject(settingsHooks) ? settingsHooks[eventName] : undefined
  return Array.isArray(fromSettings) ? fromSettings : []
}

// Why: Droid reads the switch from the top level of hooks.json but from inside the `hooks` object of
// settings.json; a top-level settings.json `hooksDisabled` is ignored.
function hooksAreDisabled(files: DroidHookFiles): boolean {
  const settingsHooks: unknown = files.settings.hooks
  return (
    files.hooksFile.hooksDisabled === true ||
    (isPlainObject(settingsHooks) && settingsHooks.hooksDisabled === true)
  )
}

export type DroidHookCoverage = {
  state: AgentHookInstallState
  managedHooksPresent: boolean
  detail: string | null
}

/**
 * Resolves each Orca event against the file Droid loads for it. An event that is shadowed or absent
 * reads as missing, so a partial set is repaired by the next install.
 */
export function resolveDroidHookCoverage(
  files: DroidHookFiles,
  command: string,
  orgAllowsManagedHooksOnly: boolean
): DroidHookCoverage {
  const missing = DROID_EVENTS.map((event) => event.eventName).filter(
    (eventName) =>
      !loadedDefinitions(files, eventName).some((definition) =>
        (definition.hooks ?? []).some((hook) => hook.command === command)
      )
  )
  const presentCount = DROID_EVENTS.length - missing.length

  // Why: report a silenced Droid in every branch, or a user would think a reinstall fixed it.
  const reasons: string[] = []
  if (hooksAreDisabled(files)) {
    reasons.push(HOOKS_DISABLED_DETAIL)
  }
  if (orgAllowsManagedHooksOnly) {
    reasons.push(ORG_MANAGED_ONLY_DETAIL)
  }
  const reasonText = reasons.length > 0 ? reasons.join('; ') : null

  if (missing.length === 0) {
    return {
      state: reasonText ? 'partial' : 'installed',
      managedHooksPresent: true,
      detail: reasonText
    }
  }
  if (presentCount === 0) {
    return {
      state: reasonText ? 'partial' : 'not_installed',
      managedHooksPresent: false,
      detail: reasonText
    }
  }
  const missingList = missing.join(', ')
  return {
    state: 'partial',
    managedHooksPresent: true,
    detail: reasonText
      ? `${reasonText}; managed hook missing for events: ${missingList}`
      : `Managed hook missing for events: ${missingList}`
  }
}
