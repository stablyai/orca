import type { AgentHookTarget } from '../../shared/agent-hook-types'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { normalizeDisabledTuiAgents } from '../../shared/tui-agent-selection'

/**
 * The off-switch predicates, kept free of the per-agent hook-service registry so startup planning
 * and other callers can read them without pulling every installer into the module graph.
 */
export type AgentStatusHookSettings = Partial<
  Pick<GlobalSettings, 'agentStatusHooksEnabled' | 'disabledTuiAgents'>
> | null

export function isAgentStatusHooksEnabled(
  settings: Partial<Pick<GlobalSettings, 'agentStatusHooksEnabled'>> | null | undefined
): boolean {
  return settings?.agentStatusHooksEnabled !== false
}

export type StartupManagedHookAction = 'install' | 'skip'

// Why never 'remove': this reads THIS instance's settings, but the managed hook files are
// user-global (~/.claude/settings.json, ~/.cursor/hooks.json). A second Orca profile with the off
// switch set would delete the hooks every other instance depends on, and Cursor — the one agent
// with no title-derived status fallback — then goes silently idle (STA-5679). Honoring the off
// switch only requires skipping the install; explicit removal stays on the Settings toggle.
export function resolveStartupManagedHookAction(
  settings: AgentStatusHookSettings
): StartupManagedHookAction {
  return isAgentStatusHooksEnabled(settings) ? 'install' : 'skip'
}

export function shouldInstallStartupManagedAgentHook(
  settings: AgentStatusHookSettings,
  agent: AgentHookTarget
): boolean {
  return (
    resolveStartupManagedHookAction(settings) === 'install' &&
    !normalizeDisabledTuiAgents(settings?.disabledTuiAgents).includes(agent)
  )
}

export function shouldContinueManagedHookStartup(
  isQuitting: boolean,
  settings: AgentStatusHookSettings,
  agent: AgentHookTarget
): boolean {
  return (
    !isQuitting &&
    isAgentStatusHooksEnabled(settings) &&
    !normalizeDisabledTuiAgents(settings?.disabledTuiAgents).includes(agent)
  )
}
