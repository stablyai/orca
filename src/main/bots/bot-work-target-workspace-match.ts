import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../shared/execution-host/execution-host'
import type { ResolvedBotWorkTargetPlacement } from '../../shared/agent-session/work-target/agent-session-work-target'
import { readWorkerTerminalHostScope } from '../../shared/orchestration/workers/worker-terminal-host-scope'
import { isFolderRepo } from '../../shared/repository/repo-kind'
import { parseWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getRegisteredSshState } from '../ssh/targets/ssh-target-registry'
import { resolveWorktreeCreateRoute } from '../workspaces/creation/worktree-create-execution-host-route'
import {
  assertManagedWorktreeMatchesTarget,
  findBotWorkTargetProjectRepo,
  type BotWorkTargetWorkspaceSummary
} from './bot-work-target-refusals'
import {
  assertProjectRegistrationCurrent,
  assertStandaloneFolderWorkTarget,
  assertWorkspaceIncarnationMatches,
  workTargetFollowUpRefusal
} from './bot-work-target-registration-checks'

export {
  isWorkTargetFollowUpMessageType,
  WORK_TARGET_NO_EFFECTS,
  workTargetFollowUpRefusal
} from './bot-work-target-registration-checks'

/** Verify an existing local/SSH workspace matches host, registration, policy, and incarnation. */
export async function verifyLocalWorkspaceMatchesWorkTarget(
  runtime: Pick<
    OrcaRuntimeService,
    'showManagedTerminalWorkspace' | 'getBotWorkTargetCatalogStore'
  >,
  args: {
    worktreeId: string
    workTarget: ResolvedBotWorkTargetPlacement
    recipientLabel: string
    workerHostScope?: string | null
    workerWorkspaceInstanceId?: string | null
    requireRecordedInstanceId?: boolean
  }
): Promise<{ worktreeId: string; managed: BotWorkTargetWorkspaceSummary }> {
  const {
    worktreeId,
    workTarget,
    recipientLabel,
    workerHostScope,
    workerWorkspaceInstanceId,
    requireRecordedInstanceId
  } = args
  if (workTarget.onEnvironmentId) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `${recipientLabel} runs on this host, not on the selected paired server.`
    )
  }
  const storeHostId = workTarget.targetHostId ?? LOCAL_EXECUTION_HOST_ID
  const parsedHost = parseExecutionHostId(storeHostId)
  if (!parsedHost || parsedHost.kind === 'runtime') {
    throw workTargetFollowUpRefusal(
      workTarget,
      `Cannot verify ${recipientLabel} against the selected target host.`
    )
  }
  if (workerHostScope !== undefined && workerHostScope !== null) {
    const scope = readWorkerTerminalHostScope(workerHostScope)
    if (scope.kind === 'unreadable') {
      throw workTargetFollowUpRefusal(
        workTarget,
        `${recipientLabel} has an unreadable host scope and cannot be verified against the selected target.`
      )
    }
    if (parsedHost.kind === 'local' && scope.kind === 'remote') {
      throw workTargetFollowUpRefusal(
        workTarget,
        `${recipientLabel} runs on a remote SSH host, not the selected local host.`
      )
    }
    if (
      parsedHost.kind === 'ssh' &&
      (scope.kind !== 'remote' || scope.targetId !== parsedHost.targetId)
    ) {
      throw workTargetFollowUpRefusal(
        workTarget,
        `${recipientLabel} does not run on the selected SSH host.`
      )
    }
  }
  if (
    parsedHost.kind === 'ssh' &&
    getRegisteredSshState(parsedHost.targetId)?.status !== 'connected'
  ) {
    throw workTargetFollowUpRefusal(workTarget, 'The SSH host for the selected target is offline.')
  }
  const store = runtime.getBotWorkTargetCatalogStore()
  if (!store) {
    throw workTargetFollowUpRefusal(
      workTarget,
      'The host project catalog is not ready to verify this worker.'
    )
  }
  const managed = await runtime
    .showManagedTerminalWorkspace(`id:${worktreeId}`, storeHostId)
    .catch(() => null)
  if (!managed || (managed.hostId ?? LOCAL_EXECUTION_HOST_ID) !== storeHostId) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `${recipientLabel}'s workspace is no longer available on the selected host.`
    )
  }

  const repos = store.getRepos()
  const projects = store.getProjects?.() ?? []
  const setups = store.getProjectHostSetups?.() ?? []
  const canonical = workTarget.canonicalTarget
  const targetWorkspaceId = canonical.workspaceId
  const parsedTargetKey = targetWorkspaceId ? parseWorkspaceKey(targetWorkspaceId) : null

  if (parsedTargetKey?.type === 'folder' && targetWorkspaceId) {
    assertStandaloneFolderWorkTarget({
      folderWorkspaceId: parsedTargetKey.folderWorkspaceId,
      targetWorkspaceId,
      managed,
      storeHostId,
      bots: store.getBots?.() ?? [],
      projectGroups: store.getProjectGroups?.() ?? [],
      folderWorkspaces: store.getFolderWorkspaces?.() ?? [],
      workTarget,
      recipientLabel
    })
    return { worktreeId: managed.id, managed }
  }

  if (managed.isArchived || store.getWorktreeMeta?.(managed.id)?.isArchived) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `${recipientLabel}'s workspace is archived and cannot receive work for the selected target.`
    )
  }

  if (workTarget.mode === 'existing') {
    if (!targetWorkspaceId || managed.id !== targetWorkspaceId) {
      throw workTargetFollowUpRefusal(
        workTarget,
        `${recipientLabel} runs in a different workspace than the selected target.`
      )
    }
    assertManagedWorktreeMatchesTarget(managed, workTarget)
    assertWorkspaceIncarnationMatches({
      managed,
      workTarget,
      recipientLabel,
      workerWorkspaceInstanceId,
      requireRecordedInstanceId
    })
    const repo =
      findBotWorkTargetProjectRepo(repos, setups, storeHostId, canonical) ??
      repos.find(
        (entry) => entry.id === managed.repoId && getRepoExecutionHostId(entry) === storeHostId
      )
    if (!repo || managed.repoId !== repo.id) {
      throw workTargetFollowUpRefusal(
        workTarget,
        `${recipientLabel}'s registered project no longer matches the selected target.`
      )
    }
    if (canonical.kind === 'project' && canonical.repoKind === 'folder' && !isFolderRepo(repo)) {
      throw workTargetFollowUpRefusal(
        workTarget,
        `${recipientLabel}'s repository is no longer a folder project.`
      )
    }
    assertProjectRegistrationCurrent({
      repo,
      storeHostId,
      repos,
      projects,
      setups,
      workTarget,
      recipientLabel
    })
    return { worktreeId: managed.id, managed }
  }

  const repo = findBotWorkTargetProjectRepo(repos, setups, storeHostId, canonical)
  if (!repo || isFolderRepo(repo) || managed.repoId !== repo.id) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `${recipientLabel} does not belong to the selected registered project.`
    )
  }
  if (canonical.repoId && managed.repoId !== canonical.repoId) {
    throw workTargetFollowUpRefusal(
      workTarget,
      `${recipientLabel} does not match the selected project's repository.`
    )
  }
  assertProjectRegistrationCurrent({
    repo,
    storeHostId,
    repos,
    projects,
    setups,
    workTarget,
    recipientLabel
  })
  if (resolveWorktreeCreateRoute(repo).kind !== 'local') {
    throw workTargetFollowUpRefusal(
      workTarget,
      'Project-level follow-up execution on this repository route is not supported; select an explicit workspace instead.'
    )
  }
  assertWorkspaceIncarnationMatches({
    managed,
    workTarget,
    recipientLabel,
    workerWorkspaceInstanceId,
    requireRecordedInstanceId
  })
  return { worktreeId: managed.id, managed }
}
