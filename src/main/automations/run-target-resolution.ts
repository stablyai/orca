import type { Store } from '../persistence'
import type { Automation } from '../../shared/automations-types'
import { getAutomationLegacyRepoId } from '../../shared/automation-run-identity'
import {
  AUTOMATION_ORPHAN_ISSUES,
  type AutomationCapturedHostIssue
} from '../../shared/automation-list-scope'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import {
  buildWorkspaceRunContext,
  type WorkspaceRunContext
} from '../../shared/task-source-context'

export type AutomationRunTargetResult =
  | { ok: true; cwd: string; repo: Repo; setup?: ProjectHostSetup }
  | { ok: false; error: string }

// Keep diagnoses distinct and stable: skip coalescing keys on exact error text.
const CAPTURED_HOST_REFUSALS: Record<AutomationCapturedHostIssue, string> = {
  [AUTOMATION_ORPHAN_ISSUES.targetMissing]:
    'The automation host is no longer registered, so this automation has nowhere to run.',
  [AUTOMATION_ORPHAN_ISSUES.targetReplaced]:
    'The automation host was removed and re-registered, so this automation must be re-adopted before it can run.',
  [AUTOMATION_ORPHAN_ISSUES.workspaceHostAmbiguous]:
    'The automation workspace spans more than one host, so Orca cannot tell which one to run it on.'
}

const NO_RUNNABLE_HOST = 'This automation has no host to run on.'

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

function resolveAutomationOwnerRefusal(store: Store, automation: Automation): string | null {
  if (store.automationOwnerPrecondition(automation.id)?.selector.kind !== 'orphan') {
    return null
  }
  const issue = store.automationCapturedHostIssue(automation)
  return issue ? CAPTURED_HOST_REFUSALS[issue] : NO_RUNNABLE_HOST
}

const LEGACY_TWIN_REFUSAL =
  'This automation was saved before Orca tracked which host it runs on, and its project is on more than one host. Open the automation and pick the host it should run on.'

function resolveLegacyAutomationRunTarget(
  store: Store,
  automation: Automation
): AutomationRunTargetResult {
  const repoId = getAutomationLegacyRepoId(automation)
  const rows = store.getRepos().filter((entry) => entry.id === repoId)
  // Reject twin repos before getRepo or owner resolution silently selects one host.
  if (rows.length > 1) {
    return { ok: false, error: LEGACY_TWIN_REFUSAL }
  }
  const ownerRefusal = resolveAutomationOwnerRefusal(store, automation)
  if (ownerRefusal) {
    return { ok: false, error: ownerRefusal }
  }
  const repo = rows[0]
  const cwd = getLegacyPrecheckCwd(store, automation)
  if (!repo || !cwd) {
    return { ok: false, error: 'Automation run target is no longer available.' }
  }
  return { ok: true, cwd, repo }
}

/** Capture a legacy host only if the folder and destination stay unchanged. */
function findLegacyAutomationRunContextStamp(
  store: Store,
  automation: Automation,
  options: AutomationRunTargetOptions
): WorkspaceRunContext | null {
  if (automation.runContext) {
    return null
  }
  const legacy = resolveLegacyAutomationRunTarget(store, automation)
  if (!legacy.ok) {
    return null
  }
  const repoHostId = getRepoExecutionHostId(legacy.repo)
  const setup = store
    .getProjectHostSetups()
    .find((candidate) => candidate.repoId === legacy.repo.id && candidate.hostId === repoHostId)
  const runContext = setup
    ? buildWorkspaceRunContext({
        projectId: setup.projectId,
        hostId: setup.hostId,
        projectHostSetupId: setup.id,
        repoId: legacy.repo.id,
        path: setup.path
      })
    : null
  if (!runContext) {
    return null
  }
  const captured = resolveAutomationRunTarget(store, { ...automation, runContext }, options)
  return captured.ok &&
    captured.cwd === legacy.cwd &&
    getRepoExecutionHostId(captured.repo) === repoHostId
    ? runContext
    : null
}

/** Capture before the dispatch snapshot so later checks use the persisted target. */
export function captureLegacyRunTarget(
  store: Store,
  automation: Automation,
  allowRemoteHostScheduling: boolean
): Automation {
  const runContext = findLegacyAutomationRunContextStamp(store, automation, {
    allowRemoteHostScheduling
  })
  if (!runContext) {
    return automation
  }
  // Another run may have captured first, even if this write was refused.
  store.stampLegacyAutomationRunContext(automation.id, runContext)
  return store.listAutomations().find((entry) => entry.id === automation.id) ?? automation
}

export function resolveAutomationRunTarget(
  store: Store,
  automation: Automation,
  options: AutomationRunTargetOptions = {}
): AutomationRunTargetResult {
  const context = automation.runContext ?? null
  if (!context) {
    return resolveLegacyAutomationRunTarget(store, automation)
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

  // Use the list’s host-generation verdict: matching IDs and paths can survive host replacement.
  const hostIssue = store.automationCapturedHostIssue(automation)
  if (hostIssue) {
    return { ok: false, error: CAPTURED_HOST_REFUSALS[hostIssue] }
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
  // Derived project IDs evolve; compare stable repo, host and path identities instead.
  if (setup.hostId !== context.hostId || setup.repoId !== context.repoId) {
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
