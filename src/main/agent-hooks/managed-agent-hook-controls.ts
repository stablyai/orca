import type { AgentHookInstallStatus, AgentHookTarget } from '../../shared/agent-hook-types'
import {
  getManagedAgentHookTarget,
  isManagedAgentHookTarget
} from '../../shared/managed-agent-hook-targets'
import { normalizeDisabledTuiAgents } from '../../shared/tui-agent-selection'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { probeClaudeCliVersion } from '../claude/claude-session-end-hook-capability'
import { detectLocalManagedAgentCliPresence } from './local-agent-cli-presence'
import {
  MANAGED_AGENT_HOOK_ASYNC_REMOVERS,
  MANAGED_AGENT_HOOK_INSTALLERS,
  MANAGED_AGENT_HOOK_REMOVERS,
  MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS,
  MANAGED_AGENT_HOOK_STATUS_READERS,
  MANAGED_AGENT_INTEGRATIONS,
  type ManagedAgentIntegration,
  type ManagedAgentHookInstallOptions,
  type ManagedAgentHookScope
} from './managed-agent-hook-registry'

export { MANAGED_AGENT_HOOK_INSTALLERS } from './managed-agent-hook-registry'
export { prepareManagedCodexHomeBeforeShellLaunch } from '../codex/managed-home-shell-preflight'

type ManagedHookSettings = Partial<
  Pick<GlobalSettings, 'agentCmdOverrides' | 'agentStatusHooksEnabled' | 'disabledTuiAgents'>
> | null

type InstallOptions = ManagedAgentHookScope & {
  /** Set only for an explicit user action, never for startup reconciliation. */
  userInitiated?: boolean
  shouldHydrateShellPath?: boolean
  onInstallError?: (agent: AgentHookTarget, error: unknown) => void
  shouldContinue?: (agent: AgentHookTarget) => boolean
  agents?: readonly AgentHookTarget[]
}

type RemoveOptions = {
  agents?: readonly AgentHookTarget[]
  scope?: ManagedAgentHookScope
}

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
  settings: ManagedHookSettings
): StartupManagedHookAction {
  return isAgentStatusHooksEnabled(settings) ? 'install' : 'skip'
}

export function shouldInstallStartupManagedAgentHook(
  settings: ManagedHookSettings,
  agent: AgentHookTarget
): boolean {
  return (
    resolveStartupManagedHookAction(settings) === 'install' &&
    !normalizeDisabledTuiAgents(settings?.disabledTuiAgents).includes(agent)
  )
}

export function shouldContinueManagedHookStartup(
  isQuitting: boolean,
  settings: ManagedHookSettings,
  agent: AgentHookTarget
): boolean {
  return (
    !isQuitting &&
    isAgentStatusHooksEnabled(settings) &&
    !normalizeDisabledTuiAgents(settings?.disabledTuiAgents).includes(agent)
  )
}

function errorStatus(agent: AgentHookTarget, error: unknown): AgentHookInstallStatus {
  return {
    agent,
    state: 'error',
    configPath: '',
    managedHooksPresent: false,
    detail: error instanceof Error ? error.message : String(error)
  }
}

function skippedStatus(
  agent: AgentHookTarget,
  skipReason: NonNullable<AgentHookInstallStatus['skipReason']>,
  detail: string
): AgentHookInstallStatus {
  return {
    agent,
    state: 'skipped',
    configPath: '',
    managedHooksPresent: false,
    detail,
    skipReason
  }
}

function managedIntegrations(): readonly ManagedAgentIntegration[] {
  if (Array.isArray(MANAGED_AGENT_INTEGRATIONS)) {
    return MANAGED_AGENT_INTEGRATIONS
  }

  // Compatibility for embedders that mocked the tuple projections before the
  // descriptor registry existed. Production always takes the branch above.
  const refreshers = new Map(MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS)
  const removers = new Map(MANAGED_AGENT_HOOK_REMOVERS)
  const asyncRemovers = new Map(MANAGED_AGENT_HOOK_ASYNC_REMOVERS)
  const readers = new Map(MANAGED_AGENT_HOOK_STATUS_READERS)
  return MANAGED_AGENT_HOOK_INSTALLERS.map(([agent, install]) => ({
    agent,
    install,
    refreshManagedScripts: refreshers.get(agent),
    remove: removers.get(agent) ?? (() => errorStatus(agent, 'remove is unavailable')),
    removeAsync: asyncRemovers.get(agent),
    getStatus: readers.get(agent) ?? (() => errorStatus(agent, 'status is unavailable'))
  }))
}

function selectedIntegrations(options: InstallOptions): readonly ManagedAgentIntegration[] {
  const integrations = managedIntegrations()
  if (!options.agents) {
    return integrations
  }
  const allowed = new Set(options.agents)
  return integrations.filter(({ agent }) => allowed.has(agent))
}

async function runInstaller(
  entry: ManagedAgentIntegration,
  onInstallError: InstallOptions['onInstallError'],
  options: ManagedAgentHookInstallOptions
): Promise<AgentHookInstallStatus> {
  const { agent, install } = entry
  try {
    return await install(options)
  } catch (error) {
    console.error(`[agent-hooks] Failed to install ${agent} managed hooks:`, error)
    try {
      onInstallError?.(agent, error)
    } catch (telemetryError) {
      console.error('[agent-hooks] Failed to record install-failure telemetry:', telemetryError)
    }
    return errorStatus(agent, error)
  }
}

// Why (#11549 aftermath): a CLI that falls off PATH keeps its user-wide config invoking
// Orca's script, but the presence gate below then skips install() forever, freezing the
// script at whatever Orca generated last. Existing scripts are Orca-owned, so bring them
// current before any gating; creating new ones remains install()'s presence-gated job.
async function refreshExistingManagedScripts(options: InstallOptions): Promise<void> {
  const allowed = options.agents ? new Set(options.agents) : null
  for (const { agent, refreshManagedScripts: refresh } of managedIntegrations()) {
    if (!refresh || (allowed !== null && !allowed.has(agent))) {
      continue
    }
    try {
      await refresh()
    } catch (error) {
      console.error(`[agent-hooks] Failed to refresh ${agent} managed script:`, error)
    }
  }
}

export async function installManagedAgentHooks(
  settings: ManagedHookSettings = null,
  options: InstallOptions = {}
): Promise<AgentHookInstallStatus[]> {
  await refreshExistingManagedScripts(options)
  const installers = selectedIntegrations(options)
  const disabled = new Set(normalizeDisabledTuiAgents(settings?.disabledTuiAgents))
  const enabledInstallers = installers.filter(({ agent }) => !disabled.has(agent))
  const targets = enabledInstallers.flatMap(({ agent }) => {
    const target = getManagedAgentHookTarget(agent)
    return target ? [target] : []
  })
  let presenceByAgent
  try {
    presenceByAgent = await detectLocalManagedAgentCliPresence(targets, settings, {
      shouldHydrateShellPath: options.shouldHydrateShellPath
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return installers.map(({ agent }) =>
      disabled.has(agent)
        ? skippedStatus(agent, 'agent_disabled', 'Agent is disabled in Settings.')
        : skippedStatus(agent, 'cli_presence_unknown', detail)
    )
  }

  const results: AgentHookInstallStatus[] = []
  for (const entry of installers) {
    const { agent } = entry
    if (disabled.has(agent)) {
      results.push(skippedStatus(agent, 'agent_disabled', 'Agent is disabled in Settings.'))
      continue
    }
    if (options.shouldContinue && !options.shouldContinue(agent)) {
      results.push(
        skippedStatus(
          agent,
          'hooks_disabled',
          'Agent status hooks were disabled before install completed.'
        )
      )
      continue
    }
    const presence = presenceByAgent[agent]
    if (presence?.state !== 'found') {
      results.push(
        skippedStatus(
          agent,
          presence?.state === 'unknown' ? 'cli_presence_unknown' : 'cli_not_found',
          'CLI not found; managed hook install skipped.'
        )
      )
      continue
    }
    const cliVersion =
      agent === 'claude' && presence.executablePath
        ? await probeClaudeCliVersion(presence.executablePath)
        : null
    results.push(
      await runInstaller(entry, options.onInstallError, {
        ...(options.userInitiated !== undefined ? { userInitiated: options.userInitiated } : {}),
        ...(options.env ? { env: options.env } : {}),
        ...(options.launchCommand ? { launchCommand: options.launchCommand } : {}),
        ...(cliVersion ? { cliVersion } : {})
      })
    )
  }
  return results
}

export async function removeManagedAgentHooks(
  options: RemoveOptions = {}
): Promise<AgentHookInstallStatus[]> {
  const allowed = options.agents ? new Set(options.agents) : null
  const results: AgentHookInstallStatus[] = []
  for (const { agent, remove } of managedIntegrations()) {
    if (allowed !== null && !allowed.has(agent)) {
      continue
    }
    try {
      results.push(await remove(options.scope))
    } catch (error) {
      results.push(errorStatus(agent, error))
    }
  }
  return results
}

export async function removeManagedAgentHooksAsync(
  options: RemoveOptions = {}
): Promise<AgentHookInstallStatus[]> {
  const allowed = options.agents ? new Set(options.agents) : null
  return await Promise.all(
    managedIntegrations()
      .filter(
        ({ agent, removeAsync }) =>
          removeAsync !== undefined && (allowed === null || allowed.has(agent))
      )
      .map(async ({ agent, removeAsync }) => {
        if (!removeAsync) {
          return errorStatus(agent, 'remove is unavailable')
        }
        try {
          return await removeAsync()
        } catch (error) {
          return errorStatus(agent, error)
        }
      })
  )
}

export function getManagedAgentHookStatuses(
  scope?: ManagedAgentHookScope
): AgentHookInstallStatus[] {
  return managedIntegrations().map(({ agent, getStatus }) => {
    try {
      return getStatus(scope)
    } catch (error) {
      return errorStatus(agent, error)
    }
  })
}

export async function applyAgentStatusHooksEnabled(
  enabled: boolean,
  settings: ManagedHookSettings = null,
  options: InstallOptions = {}
): Promise<AgentHookInstallStatus[]> {
  if (!enabled) {
    return await removeManagedAgentHooks({ scope: options })
  }
  const disabled = normalizeDisabledTuiAgents(settings?.disabledTuiAgents).filter(
    isManagedAgentHookTarget
  )
  const installed = await installManagedAgentHooks(settings, options)
  const disabledToRemove = options.shouldContinue
    ? disabled.filter((agent) => !options.shouldContinue?.(agent))
    : disabled
  if (disabledToRemove.length === 0) {
    return installed
  }
  const removed = new Map(
    (await removeManagedAgentHooks({ agents: disabledToRemove, scope: options })).map((status) => [
      status.agent,
      status
    ])
  )
  return installed.map((status) => removed.get(status.agent) ?? status)
}
