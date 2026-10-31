import { findAutomationRepo } from '../../shared/automation-repo-target'
import { findProjectHostSetup } from '../../shared/project-host-setup-target'
import type { Store } from '../persistence'
import type { Automation } from '../../shared/automations-types'
import { getAutomationLegacyRepoId } from '../../shared/automation-run-identity'
import {
  AUTOMATION_ORPHAN_ISSUES,
  type AutomationCapturedHostIssue
} from '../../shared/automation-list-scope'
import { AUTOMATION_CAPTURED_HOST_REFUSALS } from '../../shared/automation-owner-conflict'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { Repo } from '../../shared/repo-types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import {
  buildWorkspaceRunContext,
  type WorkspaceRunContext
} from '../../shared/task-source-context'
import {
  automationRunFailure,
  type AutomationRunFailure
} from '../../shared/automation-run-failure-copy'
import { AutomationDispatchCancelledError } from './automation-dispatch-cancelled-error'
import { isOrcadFencedAutomation, ORCAD_FENCED_AUTOMATION } from './orcad-fenced-automation'

export type AutomationRunTargetResult =
  | { ok: true; cwd: string; repo: Repo; setup?: ProjectHostSetup }
  | ({ ok: false } & AutomationRunFailure)

// Keep diagnoses distinct and stable: skip coalescing keys on exact error text.
const CAPTURED_HOST_REFUSALS: Record<AutomationCapturedHostIssue, () => AutomationRunFailure> = {
  [AUTOMATION_ORPHAN_ISSUES.hostReselection]: () => ({
    error: AUTOMATION_CAPTURED_HOST_REFUSALS[AUTOMATION_ORPHAN_ISSUES.hostReselection]
  }),
  [AUTOMATION_ORPHAN_ISSUES.malformed]: () => ({
    error: AUTOMATION_CAPTURED_HOST_REFUSALS[AUTOMATION_ORPHAN_ISSUES.malformed]
  }),
  [AUTOMATION_ORPHAN_ISSUES.targetMissing]: () => automationRunFailure('targetMissing'),
  [AUTOMATION_ORPHAN_ISSUES.targetReplaced]: () => automationRunFailure('targetReplaced'),
  [AUTOMATION_ORPHAN_ISSUES.workspaceHostAmbiguous]: () =>
    automationRunFailure('workspaceHostAmbiguous')
}

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

function resolveAutomationOwnerRefusal(
  store: Store,
  automation: Automation
): AutomationRunFailure | null {
  if (store.automationOwnerPrecondition(automation.id)?.selector.kind !== 'orphan') {
    return null
  }
  const issue = store.automationCapturedHostIssue(automation)
  return issue ? CAPTURED_HOST_REFUSALS[issue]() : automationRunFailure('noRunnableHost')
}

function resolveLegacyAutomationRunTarget(
  store: Store,
  automation: Automation
): AutomationRunTargetResult {
  const repoId = getAutomationLegacyRepoId(automation)
  const rows = store.getRepos().filter((entry) => entry.id === repoId)
  // Reject twin repos before getRepo or owner resolution silently selects one host.
  if (rows.length > 1) {
    return { ok: false, ...automationRunFailure('legacyTwinHosts') }
  }
  const ownerRefusal = resolveAutomationOwnerRefusal(store, automation)
  if (ownerRefusal) {
    return { ok: false, ...ownerRefusal }
  }
  const repo = rows[0]
  const cwd = getLegacyPrecheckCwd(store, automation)
  if (!repo || !cwd) {
    return { ok: false, ...automationRunFailure('targetUnavailable') }
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
  // The scheduler's first write; a fenced row must stay as the move exported it.
  if (isOrcadFencedAutomation(store, automation)) {
    throw new AutomationDispatchCancelledError(ORCAD_FENCED_AUTOMATION)
  }
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
    return { ok: false, ...automationRunFailure('remoteSchedulingUnavailable') }
  }

  // Use the list’s host-generation verdict: matching IDs and paths can survive host replacement.
  const hostIssue = store.automationCapturedHostIssue(automation)
  if (hostIssue) {
    return { ok: false, ...CAPTURED_HOST_REFUSALS[hostIssue]() }
  }

  const setup = findProjectHostSetup(store.getProjectHostSetups(), {
    setupId: context.projectHostSetupId,
    hostId: context.hostId
  })
  if (!setup) {
    return { ok: false, ...automationRunFailure('projectSetupMissing') }
  }
  if (setup.setupState !== 'ready') {
    return {
      ok: false,
      ...automationRunFailure('projectSetupNotReady', { setupState: setup.setupState })
    }
  }
  // Derived project IDs evolve; compare stable repo, host and path identities instead.
  if (setup.hostId !== context.hostId || setup.repoId !== context.repoId) {
    return { ok: false, ...automationRunFailure('targetSetupMismatch') }
  }

  const repo = findAutomationRepo(store.getRepos(), context.repoId, {
    hostId: context.hostId,
    path: setup.path
  })
  if (!repo) {
    return { ok: false, ...automationRunFailure('repoUnavailable') }
  }
  if (getRepoExecutionHostId(repo) !== context.hostId) {
    return { ok: false, ...automationRunFailure('repoDetached') }
  }
  if (repo.path !== setup.path || context.path !== setup.path) {
    return { ok: false, ...automationRunFailure('projectPathChanged') }
  }

  return { ok: true, cwd: setup.path, repo, setup }
}
