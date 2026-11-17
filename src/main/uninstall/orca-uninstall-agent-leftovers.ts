import { access, readdir, rm, rmdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-listener/configuration/agent-hook-types'
import {
  findClaudeAgentViewFiles,
  listClaudeKeybindingsPaths,
  removeClaudeAgentViewForUninstall
} from '../claude/agent-view/agent-view-uninstall'
import {
  findCodexHooksFilesWithOrcaEntries,
  listLocalCodexHookConfigFiles,
  removeEmptiedCodexHookFiles
} from '../codex/hooks/reconciliation/codex-local-hook-homes'
import { getRealHomeHooksPristineBackupPath } from '../codex/hooks/reconciliation/codex-real-home-hooks-json'
import { findOrcaConfigBackup, removeOrcaConfigBackups } from './orca-config-backups'
import { orcaUninstallErrorText } from './orca-uninstall-error-text'
import { runWithoutRollingFileBackups } from '../filesystem/rolling-file-backup'
import {
  getManagedAgentHookStatuses,
  removeManagedAgentHooks
} from '../agent-hooks/installation/managed-agent-hook-controls'
import { isManagedAgentHookTarget } from '../../shared/agent-hook-listener/configuration/managed-agent-hook-targets'
import { collapseHomePath } from '../../shared/skills/bundled/bundled-skill-locations'
import type { OrcaUninstallAgentEntry } from '../../shared/uninstall/orca-uninstall-types'

/** Whether the agent's own config still runs Orca's hooks; Codex checks every local home. */
function hasOrcaHookEntries(status: AgentHookInstallStatus): boolean {
  return status.agent === 'codex'
    ? findCodexHooksFilesWithOrcaEntries().length > 0
    : status.managedHooksPresent
}

async function backupCandidates(status: AgentHookInstallStatus): Promise<string[]> {
  const extra =
    status.agent === 'codex'
      ? listLocalCodexHookConfigFiles()
      : status.agent === 'claude'
        ? await listClaudeKeybindingsPaths()
        : []
  return [...new Set([...(status.configPath ? [status.configPath] : []), ...extra])]
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false
  )
}

/** Every file uninstall would change or delete for this agent; empty when nothing of Orca's is left. */
async function findAgentLeftovers(
  status: AgentHookInstallStatus,
  userDataPath: string
): Promise<string[]> {
  const hooked =
    status.agent === 'codex'
      ? findCodexHooksFilesWithOrcaEntries()
      : status.managedHooksPresent
        ? [status.configPath]
        : []
  const pristine = getRealHomeHooksPristineBackupPath(userDataPath)
  const owned =
    status.agent === 'claude'
      ? await findClaudeAgentViewFiles()
      : status.agent === 'codex' && (await exists(pristine))
        ? [pristine]
        : []
  const backups = await Promise.all((await backupCandidates(status)).map(findOrcaConfigBackup))
  return [
    ...new Set([...hooked, ...owned, ...backups.filter((path): path is string => path !== null)])
  ]
}

/** Runs after the agent's hooks are removed, so its backups no longer have a reason to stay. */
async function removeAgentLeftovers(
  status: AgentHookInstallStatus,
  userDataPath: string
): Promise<void> {
  if (status.agent === 'claude') {
    await removeClaudeAgentViewForUninstall()
  }
  if (status.agent === 'codex') {
    const pristine = getRealHomeHooksPristineBackupPath(userDataPath)
    await rm(pristine, { force: true })
    const dir = dirname(pristine)
    if ((await readdir(dir).catch(() => ['?'])).length === 0) {
      await rmdir(dir)
    }
  }
  await removeOrcaConfigBackups(await backupCandidates(status))
  if (status.agent === 'codex') {
    await removeEmptiedCodexHookFiles()
  }
}

type AgentOutcome = Pick<OrcaUninstallAgentEntry, 'state' | 'detail'>
type Roots = { homeDir: string; userDataPath: string }

/** Registry agents with anything of Orca's left, and the files uninstall would change or delete. */
export async function listRegistryAgentLeftovers(
  userDataPath: string
): Promise<{ agent: string; paths: string[] }[]> {
  const entries = await Promise.all(
    getManagedAgentHookStatuses().map(async (status) => ({
      agent: status.agent,
      paths: await findAgentLeftovers(status, userDataPath)
    }))
  )
  return entries.filter((entry) => entry.paths.length > 0)
}

async function outcomeAfterRemoval(
  agent: string,
  removed: AgentHookInstallStatus | undefined,
  roots: Roots
): Promise<AgentOutcome> {
  if (removed && (removed.state === 'error' || removed.managedHooksPresent)) {
    return { state: 'error', detail: removed.detail ?? 'Orca hooks are still in this file.' }
  }
  const status = getManagedAgentHookStatuses().find((entry) => entry.agent === agent)
  const left = status ? await findAgentLeftovers(status, roots.userDataPath) : []
  return left.length === 0
    ? { state: 'removed', detail: null }
    : { state: 'error', detail: `${collapseHomePath(left[0], roots.homeDir)} is still there.` }
}

/** Removes each agent's hooks, then the files Orca left around them; keyed by agent. */
export async function removeRegistryAgentHooks(
  agents: ReadonlySet<string>,
  roots: Roots
): Promise<Map<string, AgentOutcome>> {
  const before = getManagedAgentHookStatuses().filter((status) => agents.has(status.agent))
  // Only configs that still run Orca's hooks: some removers would create an empty file otherwise.
  const hooked = before
    .filter(hasOrcaHookEntries)
    .map((status) => status.agent)
    .filter(isManagedAgentHookTarget)
  const removed = new Map<string, AgentHookInstallStatus>(
    hooked.length === 0
      ? []
      : (await removeManagedAgentHooks({ agents: hooked })).map((status) => [status.agent, status])
  )
  const outcomes = new Map<string, AgentOutcome>()
  for (const status of before) {
    // A config Orca could not clean may need its backup to recover.
    if (removed.get(status.agent)?.state !== 'error') {
      try {
        // Removal writes must not rotate the hooked copy into a backup this step deletes.
        await runWithoutRollingFileBackups(() => removeAgentLeftovers(status, roots.userDataPath))
      } catch (error) {
        outcomes.set(status.agent, { state: 'error', detail: orcaUninstallErrorText(error) })
        continue
      }
    }
    outcomes.set(
      status.agent,
      await outcomeAfterRemoval(status.agent, removed.get(status.agent), roots)
    )
  }
  return outcomes
}
