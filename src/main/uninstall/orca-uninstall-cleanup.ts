import { access, readdir, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-listener/configuration/agent-hook-types'
import { isManagedAgentHookTarget } from '../../shared/agent-hook-listener/configuration/managed-agent-hook-targets'
import type { CliInstallStatus } from '../../shared/cli/cli-install-types'
import {
  listInstalledServeServiceUnits,
  removeServeServiceUnit,
  runServeServiceManager,
  type ServeServiceRun
} from '../../shared/remote-runtime/serve-supervisor/serve-service-unit-removal'
import type {
  OrcaUninstallAgentEntry,
  OrcaUninstallHostEntry,
  OrcaUninstallPlan,
  OrcaUninstallSimpleEntry,
  OrcaUninstallStep
} from '../../shared/uninstall/orca-uninstall-types'
import {
  getManagedAgentHookStatuses,
  removeManagedAgentHooks
} from '../agent-hooks/installation/managed-agent-hook-controls'
import {
  findPluginHookFiles,
  removePluginHookFiles,
  type PluginHookRemoval
} from '../agent-hooks/installation/opencode-pi-plugin-hook-files'
import type { OrcaInstallIdentity } from './orca-install-identity'
import { forgetClaudeAgentViewMarkers } from '../claude/agent-view/agent-view-uninstall'
import { collapseHomePath } from '../../shared/skills/bundled/bundled-skill-locations'
import { describeOrcaUninstallPath } from './orca-uninstall-path-display'

/** What the desktop app and `orca uninstall` each supply; the cleanup itself is shared. */
export type OrcaUninstallHost = {
  platform: NodeJS.Platform
  homeDir: string
  userDataPath: string
  uid: number
  identity: OrcaInstallIdentity
  /** Persists `agentStatusHooksEnabled: false`, so startup reconciliation cannot reinstall. */
  disableAgentStatusHooks: () => Promise<void>
  /** Null when this host cannot read the `orca` command registration. */
  getCliStatus: () => Promise<CliInstallStatus | null>
  removeCli: () => Promise<CliInstallStatus>
  listHosts: () => Promise<OrcaUninstallHostEntry[]>
  removeHostHooks: (hostId: string) => Promise<void>
  runServiceManager?: ServeServiceRun
}

export const ORCA_UNINSTALL_MANUAL_COMMAND = 'orca uninstall'
const PLUGIN_AGENTS: ReadonlySet<string> = new Set(['opencode', 'pi', 'omp', 'prime-agent'])

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]
}

function isOrcaOwnedCli(status: CliInstallStatus | null): status is CliInstallStatus {
  return status !== null && (status.state === 'installed' || status.state === 'stale')
}

async function serviceEntry(host: OrcaUninstallHost): Promise<OrcaUninstallSimpleEntry | null> {
  const units = await listInstalledServeServiceUnits(host.platform, host.homeDir)
  return units.length === 0
    ? null
    : { location: units.map((unit) => unit.name).join(', '), state: 'present', detail: null }
}

/** Read-only: lists what Orca added outside its own folders. */
export async function buildOrcaUninstallPlan(host: OrcaUninstallHost): Promise<OrcaUninstallPlan> {
  const registryAgents: OrcaUninstallAgentEntry[] = getManagedAgentHookStatuses()
    .filter((status) => status.managedHooksPresent)
    .map((status) => ({
      agent: status.agent,
      paths: status.configPath ? [describeOrcaUninstallPath(status.configPath, host)] : [],
      state: 'present',
      detail: null
    }))
  const pluginAgents: OrcaUninstallAgentEntry[] = (
    await findPluginHookFiles({ homeDir: host.homeDir })
  ).map((entry) => ({
    ...entry,
    paths: entry.paths.map((path) => describeOrcaUninstallPath(path, host)),
    state: 'present',
    detail: null
  }))
  const cli = await host.getCliStatus().catch(() => null)
  const scripts = join(host.homeDir, '.orca', 'agent-hooks')
  const scriptsMissing = await access(scripts).catch(() => true)
  return {
    installKind: host.identity.installKind,
    agents: [...registryAgents, ...pluginAgents],
    cliCommand: isOrcaOwnedCli(cli)
      ? {
          commandName: cli.commandName,
          location: cli.commandPath
            ? collapseHomePath(cli.commandPath, host.homeDir)
            : cli.commandName,
          state: 'present',
          detail: null
        }
      : null,
    backgroundService: await serviceEntry(host),
    hookScripts: !scriptsMissing
      ? { location: collapseHomePath(scripts, host.homeDir), state: 'present', detail: null }
      : null,
    hosts: await host.listHosts(),
    otherOrcaBuildName: host.identity.otherOrcaBuildName,
    appPath: host.identity.appPath,
    removeAppCommand: host.identity.removeAppCommand
  }
}

function isPending(
  entry: { state: string },
  only: ReadonlySet<string> | null,
  id: string
): boolean {
  return entry.state !== 'removed' && (only === null || only.has(id))
}

function registryOutcome(
  status: AgentHookInstallStatus | undefined
): Pick<OrcaUninstallAgentEntry, 'state' | 'detail'> {
  if (!status) {
    return { state: 'removed', detail: null }
  }
  if (status.state === 'error' || status.managedHooksPresent) {
    return { state: 'error', detail: status.detail ?? 'Orca hooks are still in this file.' }
  }
  return { state: 'removed', detail: null }
}

async function runAgentHooks(
  plan: OrcaUninstallPlan,
  host: OrcaUninstallHost,
  only: ReadonlySet<string> | null
): Promise<OrcaUninstallAgentEntry[]> {
  const pending = plan.agents.filter((entry) => isPending(entry, only, entry.agent))
  if (pending.length === 0) {
    return plan.agents
  }
  const update = (
    outcome: (entry: OrcaUninstallAgentEntry) => Pick<OrcaUninstallAgentEntry, 'state' | 'detail'>
  ): OrcaUninstallAgentEntry[] =>
    plan.agents.map((entry) => (pending.includes(entry) ? { ...entry, ...outcome(entry) } : entry))
  const otherBuild = plan.otherOrcaBuildName
  if (otherBuild) {
    return update(() => ({ state: 'kept-shared', detail: `${otherBuild} still uses these hooks.` }))
  }
  try {
    await host.disableAgentStatusHooks()
  } catch (error) {
    const detail = `Could not turn off agent status hooks: ${errorText(error)}`
    return update(() => ({ state: 'error', detail }))
  }
  const pluginRemovals = new Map<string, PluginHookRemoval>(
    (
      await removePluginHookFiles({
        homeDir: host.homeDir,
        agents: pending.map((entry) => entry.agent)
      })
    ).map((removal) => [removal.agent, removal])
  )
  const registryAgents = pending.map((entry) => entry.agent).filter(isManagedAgentHookTarget)
  const statuses = new Map<string, AgentHookInstallStatus>(
    registryAgents.length === 0
      ? []
      : (await removeManagedAgentHooks({ agents: registryAgents })).map((status) => [
          status.agent,
          status
        ])
  )
  const claude = statuses.get('claude')
  if (claude && registryOutcome(claude).state === 'removed') {
    await forgetClaudeAgentViewMarkers().catch(() => {})
  }
  return update((entry) => {
    const plugin = pluginRemovals.get(entry.agent)
    if (plugin) {
      return plugin.error
        ? { state: 'error', detail: plugin.error }
        : { state: 'removed', detail: null }
    }
    return PLUGIN_AGENTS.has(entry.agent)
      ? { state: 'removed', detail: null }
      : registryOutcome(statuses.get(entry.agent))
  })
}

async function runCliCommand(
  plan: OrcaUninstallPlan,
  host: OrcaUninstallHost
): Promise<OrcaUninstallPlan['cliCommand']> {
  const entry = plan.cliCommand
  if (!entry || entry.state === 'removed') {
    return entry
  }
  try {
    const status = await host.removeCli()
    return isOrcaOwnedCli(status)
      ? { ...entry, state: 'error', detail: status.detail ?? 'The command is still registered.' }
      : { ...entry, state: 'removed', detail: null }
  } catch (error) {
    return { ...entry, state: 'error', detail: errorText(error) }
  }
}

async function runBackgroundService(
  plan: OrcaUninstallPlan,
  host: OrcaUninstallHost
): Promise<OrcaUninstallSimpleEntry | null> {
  const entry = plan.backgroundService
  if (!entry || entry.state === 'removed') {
    return entry
  }
  const run = host.runServiceManager ?? runServeServiceManager
  try {
    for (const unit of await listInstalledServeServiceUnits(host.platform, host.homeDir)) {
      await removeServeServiceUnit(unit, run, host.uid)
    }
  } catch (error) {
    return { ...entry, state: 'error', detail: errorText(error) }
  }
  const left = await listInstalledServeServiceUnits(host.platform, host.homeDir)
  return left.length === 0
    ? { ...entry, state: 'removed', detail: null }
    : { ...entry, state: 'error', detail: `Still installed: ${left.map((u) => u.name).join(', ')}` }
}

async function runHookScripts(
  plan: OrcaUninstallPlan,
  host: OrcaUninstallHost
): Promise<OrcaUninstallSimpleEntry | null> {
  const entry = plan.hookScripts
  if (!entry || entry.state === 'removed') {
    return entry
  }
  if (plan.otherOrcaBuildName) {
    return { ...entry, state: 'kept-shared', detail: `${plan.otherOrcaBuildName} still uses them.` }
  }
  // Hook entries left in an agent's config still call these scripts on every event.
  const stillHooked = plan.agents.filter(
    (agent) => agent.state !== 'removed' && !PLUGIN_AGENTS.has(agent.agent)
  )
  if (stillHooked.length > 0) {
    const names = stillHooked.map((agent) => agent.agent).join(', ')
    return { ...entry, state: 'kept-shared', detail: `Still used by ${names}.` }
  }
  try {
    const dir = join(host.homeDir, '.orca', 'agent-hooks')
    await rm(dir, { recursive: true, force: true })
    const orcaDir = join(host.homeDir, '.orca')
    if ((await readdir(orcaDir).catch(() => ['?'])).length === 0) {
      await rmdir(orcaDir)
    }
    return { ...entry, state: 'removed', detail: null }
  } catch (error) {
    return { ...entry, state: 'error', detail: errorText(error) }
  }
}

async function runSshHosts(
  plan: OrcaUninstallPlan,
  host: OrcaUninstallHost,
  only: ReadonlySet<string> | null
): Promise<OrcaUninstallHostEntry[]> {
  const results: OrcaUninstallHostEntry[] = []
  for (const entry of plan.hosts) {
    if (!isPending(entry, only, entry.hostId)) {
      results.push(entry)
      continue
    }
    if (!entry.connected) {
      results.push({
        ...entry,
        state: 'needs-user',
        detail: 'Not connected.',
        manualCommand: ORCA_UNINSTALL_MANUAL_COMMAND
      })
      continue
    }
    try {
      await host.removeHostHooks(entry.hostId)
      results.push({ ...entry, state: 'removed', detail: null, manualCommand: null })
    } catch (error) {
      results.push({
        ...entry,
        state: 'error',
        detail: errorText(error),
        manualCommand: ORCA_UNINSTALL_MANUAL_COMMAND
      })
    }
  }
  return results
}

/** Runs one step and returns the whole plan with that step's entries updated. */
export async function runOrcaUninstallStep(
  plan: OrcaUninstallPlan,
  step: OrcaUninstallStep,
  host: OrcaUninstallHost,
  only?: readonly string[]
): Promise<OrcaUninstallPlan> {
  const filter = only && only.length > 0 ? new Set(only) : null
  switch (step) {
    case 'agent-hooks':
      return { ...plan, agents: await runAgentHooks(plan, host, filter) }
    case 'cli-command':
      return { ...plan, cliCommand: await runCliCommand(plan, host) }
    case 'background-service':
      return { ...plan, backgroundService: await runBackgroundService(plan, host) }
    case 'hook-scripts':
      return { ...plan, hookScripts: await runHookScripts(plan, host) }
    case 'ssh-hosts':
      return { ...plan, hosts: await runSshHosts(plan, host, filter) }
  }
}
