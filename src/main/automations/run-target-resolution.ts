import type { Store } from '../persistence'
import type { Automation } from '../../shared/automations-types'
import { getAutomationLegacyRepoId } from '../../shared/automation-run-identity'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import type { ProjectHostSetup, Repo } from '../../shared/types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'

export type AutomationRunTargetResult =
  | { ok: true; cwd: string; repo: Repo; setup?: ProjectHostSetup }
  | { ok: false; error: string }

type AutomationRunTargetOptions = {
  allowRemoteHostScheduling?: boolean
}

function getLegacyPrecheckCwd(store: Store, automation: Automation): string | null {
  if (automation.workspaceMode === 'existing') {
    const parsed = automation.workspaceId
      ? splitWorktreeIdForFilesystem(automation.workspaceId)
      : null
    return parsed?.worktreePath ?? null
  }
  return store.getRepo(getAutomationLegacyRepoId(automation))?.path ?? null
}

export function resolveAutomationRunTarget(
  store: Store,
  automation: Automation,
  options: AutomationRunTargetOptions = {}
): AutomationRunTargetResult {
  const context = automation.runContext ?? null
  if (!context) {
    const repo = store.getRepo(getAutomationLegacyRepoId(automation))
    const cwd = getLegacyPrecheckCwd(store, automation)
    if (!repo || !cwd) {
      return { ok: false, error: 'Automation run target is no longer available.' }
    }
    return { ok: true, cwd, repo }
  }
  const parsedHost = parseExecutionHostId(context.hostId)
  if (
    parsedHost?.kind === 'runtime' &&
    (!options.allowRemoteHostScheduling || automation.schedulerOwner !== 'remote_host_service')
  ) {
    return {
      ok: false,
      error:
        'Remote-server automation scheduling is not available from this Orca client yet. Run this automation on the remote server or update Orca when durable remote scheduling is available.'
    }
  }

  const setup = store
    .getProjectHostSetups()
    .find((candidate) => candidate.id === context.projectHostSetupId)
  if (!setup) {
    return {
      ok: false,
      error: 'Project is not set up on the selected automation host anymore.'
    }
  }
  if (setup.setupState !== 'ready') {
    return {
      ok: false,
      error: `Project setup on the selected automation host is ${setup.setupState}.`
    }
  }
  if (
    setup.projectId !== context.projectId ||
    setup.hostId !== context.hostId ||
    setup.repoId !== context.repoId
  ) {
    return {
      ok: false,
      error: 'Automation run target no longer matches the selected project host setup.'
    }
  }

  const repo = store.getRepo(context.repoId)
  if (!repo) {
    return {
      ok: false,
      error: 'Repository for the selected automation host is no longer available.'
    }
  }
  if (getRepoExecutionHostId(repo) !== context.hostId) {
    return {
      ok: false,
      error: 'Repository is no longer attached to the selected automation host.'
    }
  }
  if (repo.path !== setup.path || context.path !== setup.path) {
    return {
      ok: false,
      error: 'Project path for the selected automation host has changed.'
    }
  }

  return { ok: true, cwd: setup.path, repo, setup }
}
