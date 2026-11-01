import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { readHooksJson } from '../agent-hooks/installer-utils'
import {
  getWindowsClaudeHookExecutablePath,
  getWindowsClaudeHookFileStatus
} from './windows-hook-files'
import {
  getConfigPath,
  getManagedScriptPath,
  getManagedEventHook,
  findManagedEventHookForms,
  type ClaudeCompatibleHookSettings
} from './hook-settings'
import type { ClaudeManagedHookPlan } from './claude-managed-hook-events'

export function getClaudeHookStatus(
  options: {
    agent: AgentHookInstallStatus['agent']
    displayName: string
    settings: ClaudeCompatibleHookSettings
  },
  configDir: string | undefined,
  plan: ClaudeManagedHookPlan,
  usesWindowsEntry: boolean
): AgentHookInstallStatus {
  const configPath = getConfigPath(options.settings, configDir)
  const scriptPath = getManagedScriptPath(options.settings)
  const config = readHooksJson(configPath)
  if (!config) {
    return {
      agent: options.agent,
      state: 'error',
      configPath,
      managedHooksPresent: false,
      detail: `Could not parse ${options.displayName} settings.json`
    }
  }

  // Count either Windows launcher form: installation falls back to .cmd when the exe cannot be placed.
  const exePath = usesWindowsEntry ? getWindowsClaudeHookExecutablePath(scriptPath) : null
  const events = plan.install.map((event) => event.eventName)
  const { missing, matchedForms } = findManagedEventHookForms(config, events, (eventName) =>
    [null, exePath].map((path) =>
      // An installed exec form proves its CLI accepted it, whatever the probe now reports.
      getManagedEventHook(eventName, scriptPath, options.settings, path, { execForm: true })
    )
  )
  const presentCount = matchedForms.length
  const managedHooksPresent = presentCount > 0
  let state: AgentHookInstallState
  let detail: string | null
  if (missing.length === 0) {
    state = 'installed'
    detail = null
  } else if (presentCount === 0) {
    state = 'not_installed'
    detail = null
  } else {
    state = 'partial'
    detail = `Managed hook missing for events: ${missing.join(', ')}`
  }
  const status = { agent: options.agent, state, configPath, managedHooksPresent, detail }
  return usesWindowsEntry
    ? getWindowsClaudeHookFileStatus(status, scriptPath, matchedForms.includes(1))
    : status
}
