import type { AgentHookInstallStatus, AgentHookTarget } from '../../shared/agent-hook-types'
import {
  getManagedAgentHookTarget,
  isManagedAgentHookTarget
} from '../../shared/managed-agent-hook-targets'
import { normalizeDisabledTuiAgents } from '../../shared/tui-agent-selection'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  isAgentStatusHooksEnabled,
  isAgentStatusHooksEnabledForAgent
} from '../../shared/agent-status-hooks-setting'
import type { ManagedHookInvocation } from '../claude/claude-hook-target'
import { probeClaudeCliVersion } from '../claude/claude-hook-event-versions'
import { detectLocalManagedAgentCliPresence } from './local-agent-cli-presence'
import {
  MANAGED_AGENT_HOOK_ASYNC_REMOVERS,
  MANAGED_AGENT_HOOK_INSTALLERS,
  MANAGED_AGENT_HOOK_REMOVERS,
  MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS,
  MANAGED_AGENT_HOOK_STATUS_READERS,
  type ManagedAgentHookInstaller,
  type ManagedAgentHookInstallOptions
} from './managed-agent-hook-registry'

export { MANAGED_AGENT_HOOK_INSTALLERS } from './managed-agent-hook-registry'
export {
  isAgentStatusHooksEnabled,
  isAgentStatusHooksEnabledForAgent
} from '../../shared/agent-status-hooks-setting'

type ManagedHookSettings = Partial<
  Pick<GlobalSettings, 'agentCmdOverrides' | 'agentStatusHooksEnabled' | 'disabledTuiAgents'>
> | null

type InstallOptions = ManagedHookInvocation & {
  signal?: AbortSignal
  /** Set only for an explicit user action, never for startup reconciliation. */
  userInitiated?: boolean
  shouldHydrateShellPath?: boolean
  onInstallError?: (agent: AgentHookTarget, error: unknown) => void
  shouldContinue?: (agent: AgentHookTarget) => boolean
  agents?: readonly AgentHookTarget[]
}

type ApplyOptions = InstallOptions & {
  /** Off means skip, never remove: another Orca's panes run on these same user-global entries. */
  keepSharedEntries?: boolean
}

type RemoveOptions = ManagedHookInvocation & {
  agents?: readonly AgentHookTarget[]
  signal?: AbortSignal
  shouldContinue?: (agent: AgentHookTarget) => boolean
}

export type StartupManagedHookAction = 'install' | 'skip'

// Settings are per profile but hooks are user-global; startup removal would break other instances.
export function resolveStartupManagedHookAction(
  settings: ManagedHookSettings
): StartupManagedHookAction {
  return isAgentStatusHooksEnabled(settings) ? 'install' : 'skip'
}

export function shouldContinueManagedHookStartup(
  isQuitting: boolean,
  settings: ManagedHookSettings,
  agent: AgentHookTarget
): boolean {
  return !isQuitting && isAgentStatusHooksEnabledForAgent(settings, agent)
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

function selectedInstallers(options: InstallOptions): readonly ManagedAgentHookInstaller[] {
  if (!options.agents) {
    return MANAGED_AGENT_HOOK_INSTALLERS
  }
  const allowed = new Set(options.agents)
  return MANAGED_AGENT_HOOK_INSTALLERS.filter(([agent]) => allowed.has(agent))
}

async function runInstaller(
  entry: ManagedAgentHookInstaller,
  onInstallError: InstallOptions['onInstallError'],
  options: ManagedAgentHookInstallOptions
): Promise<AgentHookInstallStatus> {
  const [agent, install] = entry
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

// Refresh owned scripts before CLI presence gating; user-wide configs may still invoke them.
async function refreshExistingManagedScripts(options: InstallOptions): Promise<void> {
  const allowed = options.agents ? new Set(options.agents) : null
  for (const [agent, refresh] of MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS) {
    if (allowed !== null && !allowed.has(agent)) {
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
  const installers = selectedInstallers(options)
  const disabled = new Set(normalizeDisabledTuiAgents(settings?.disabledTuiAgents))
  const enabledInstallers = installers.filter(([agent]) => !disabled.has(agent))
  const targets = enabledInstallers.flatMap(([agent]) => {
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
    return installers.map(([agent]) =>
      disabled.has(agent)
        ? skippedStatus(agent, 'agent_disabled', 'Agent is disabled in Settings.')
        : skippedStatus(agent, 'cli_presence_unknown', detail)
    )
  }

  const results: (AgentHookInstallStatus | Promise<AgentHookInstallStatus>)[] = []
  for (const entry of installers) {
    const [agent] = entry
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
    const installing = runInstaller(entry, options.onInstallError, {
      ...(options.userInitiated !== undefined ? { userInitiated: options.userInitiated } : {}),
      ...(cliVersion ? { cliVersion } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.shouldContinue
        ? { shouldContinue: () => options.shouldContinue?.(agent) !== false }
        : {})
    })
    results.push(agent === 'claude' ? installing : await installing)
  }
  return await Promise.all(results.map((result) => Promise.resolve(result)))
}

export async function removeManagedAgentHooks(
  options: RemoveOptions = {}
): Promise<AgentHookInstallStatus[]> {
  const allowed = options.agents ? new Set(options.agents) : null
  const results: AgentHookInstallStatus[] = []
  for (const [agent, remove] of MANAGED_AGENT_HOOK_REMOVERS) {
    if (allowed !== null && !allowed.has(agent)) {
      continue
    }
    try {
      results.push(
        await remove({
          ...options,
          shouldContinue: options.shouldContinue
            ? () => options.shouldContinue?.(agent) !== false
            : undefined
        })
      )
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
    MANAGED_AGENT_HOOK_ASYNC_REMOVERS.filter(
      ([agent]) => allowed === null || allowed.has(agent)
    ).map(async ([agent, remove]) => {
      try {
        return await remove()
      } catch (error) {
        return errorStatus(agent, error)
      }
    })
  )
}

export async function getManagedAgentHookStatuses(
  options: ManagedHookInvocation = {}
): Promise<AgentHookInstallStatus[]> {
  return Promise.all(
    MANAGED_AGENT_HOOK_STATUS_READERS.map(async ([agent, getStatus]) => {
      try {
        return await getStatus(options)
      } catch (error) {
        return errorStatus(agent, error)
      }
    })
  )
}

export async function applyAgentStatusHooksEnabled(
  enabled: boolean,
  settings: ManagedHookSettings = null,
  options: ApplyOptions = {}
): Promise<AgentHookInstallStatus[]> {
  const removalOptions = {
    ...options,
    shouldContinue: options.shouldContinue
      ? (agent: AgentHookTarget) => options.shouldContinue?.(agent) === false
      : undefined
  }
  if (!enabled) {
    return options.keepSharedEntries
      ? getManagedAgentHookStatuses(options)
      : await removeManagedAgentHooks(removalOptions)
  }
  const disabled = normalizeDisabledTuiAgents(settings?.disabledTuiAgents)
    .filter(isManagedAgentHookTarget)
    .filter((agent) => !options.agents || options.agents.includes(agent))
  const installed = await installManagedAgentHooks(settings, options)
  const disabledToRemove = options.shouldContinue
    ? disabled.filter((agent) => !options.shouldContinue?.(agent))
    : disabled
  if (disabledToRemove.length === 0 || options.keepSharedEntries) {
    return installed
  }
  const removed = new Map(
    (await removeManagedAgentHooks({ ...removalOptions, agents: disabledToRemove })).map(
      (status) => [status.agent, status]
    )
  )
  return installed.map((status) => removed.get(status.agent) ?? status)
}
