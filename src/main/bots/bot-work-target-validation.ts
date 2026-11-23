import type { Bot } from '../../shared/bot-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import { refuse } from '../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentJournalWorkTarget } from '../../shared/agent-session/work-target/agent-session-work-target'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import type { Project, ProjectHostSetup } from '../../shared/project/project-types'
import { indexHiddenProjects } from '../../shared/project/catalog/hidden-projects'
import type { ProjectGroup } from '../../shared/project/groups/project-group-types'
import { isFolderRepo } from '../../shared/repository/repo-kind'
import type { Repo } from '../../shared/repository/repo-types'
import {
  folderWorkspaceKey,
  parseWorkspaceKey
} from '../../shared/workspace/identity/workspace-scope'
import type { Worktree } from '../../shared/worktree/types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { getRegisteredSshState } from '../ssh/targets/ssh-target-registry'
import { botsRootFolder, isBotsProjectGroup } from './bot-home'
import {
  validatePairedServerWorkTarget,
  type BotWorkTargetValidationResult,
  type PairedServerWorkTargetValidationDeps
} from './bot-work-target-remote-validation'

export type { BotWorkTargetValidationResult } from './bot-work-target-remote-validation'

export type BotWorkTargetWorkspaceSummary = Pick<
  Worktree,
  'id' | 'repoId' | 'displayName' | 'branch' | 'path' | 'isArchived'
>

export type BotWorkTargetValidationDeps = PairedServerWorkTargetValidationDeps & {
  /** Execution host identity of this runtime (`local` or `runtime:<environmentId>`). */
  hostId: string
  isBotHome: (workspaceId: string) => boolean
  store: () => {
    getBots?: () => readonly Bot[]
    getRepos: () => readonly Repo[]
    getProjects?: () => readonly Project[]
    getProjectHostSetups?: () => readonly ProjectHostSetup[]
    getFolderWorkspaces?: () => readonly FolderWorkspace[]
    getProjectGroups?: () => readonly ProjectGroup[]
    getWorktreeMeta?: (worktreeId: string) => WorktreeMeta | undefined
  } | null
  showManagedTerminalWorkspace: (
    selector: string,
    requiredHostId?: ExecutionHostId
  ) => Promise<BotWorkTargetWorkspaceSummary>
  botsRoot?: () => string
  getSshConnectionStatus?: (targetId: string) => string | undefined
}

function refuseTarget(
  reason: 'workTargetUnavailable' | 'workTargetHostUnavailable' | 'workTargetUnsupportedChat',
  message: string
): BotWorkTargetValidationResult {
  return { ok: false, refusal: refuse('agent_session_operation_invalid', { reason }, message) }
}

const refuseUnavailable = (message: string) => refuseTarget('workTargetUnavailable', message)
const refuseHostUnavailable = (message: string) =>
  refuseTarget('workTargetHostUnavailable', message)
const refuseUnsupportedChat = () =>
  refuseTarget(
    'workTargetUnsupportedChat',
    'Project and workspace targeting is only available in bot chats.'
  )

function folderWorkspaceHostId(workspace: FolderWorkspace): ExecutionHostId {
  if (workspace.executionHostId) {
    return workspace.executionHostId
  }
  return workspace.connectionId ? `ssh:${workspace.connectionId}` : LOCAL_EXECUTION_HOST_ID
}

function isRuntimeOwnerOfHost(runtimeHostId: string, targetHostId: ExecutionHostId): boolean {
  return targetHostId === LOCAL_EXECUTION_HOST_ID
    ? runtimeHostId === LOCAL_EXECUTION_HOST_ID
    : runtimeHostId === targetHostId
}

/** Validate a user-selected project or workspace against live host state without fallback. */
export async function validateBotWorkTarget(
  deps: BotWorkTargetValidationDeps,
  record: Pick<AgentSessionRecord, 'location'>,
  target: AgentJournalWorkTarget
): Promise<BotWorkTargetValidationResult> {
  if (!deps.isBotHome(record.location.workspaceId)) {
    return refuseUnsupportedChat()
  }
  const parsedHost = parseExecutionHostId(target.hostId)
  if (!parsedHost) {
    return refuseHostUnavailable('The host for the selected project or workspace is invalid.')
  }
  const store = deps.store()
  if (!store) {
    return refuseUnavailable('The host project catalog is not ready.')
  }

  // Paired-server target from a different runtime (e.g., local desktop bot targeting a paired server).
  if (parsedHost.kind === 'runtime' && !isRuntimeOwnerOfHost(deps.hostId, parsedHost.id)) {
    return validatePairedServerWorkTarget(deps, parsedHost.environmentId, target)
  }
  // A remote bot runtime cannot reach the desktop client's local host or another machine's local repos.
  if (parsedHost.kind === 'local' && deps.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return refuseHostUnavailable(
      'This bot runs on a remote host and cannot target a local project on another computer.'
    )
  }
  if (parsedHost.kind === 'ssh') {
    const status =
      deps.getSshConnectionStatus?.(parsedHost.targetId) ??
      getRegisteredSshState(parsedHost.targetId)?.status
    if (status !== undefined && status !== 'connected') {
      return refuseHostUnavailable('The SSH host for the selected project or workspace is offline.')
    }
  }

  return validateLocalStoreWorkTarget(deps, store, parsedHost.id, target)
}

/** Build a bound validator callback from runtime services so wiring stays concise. */
export function createBotWorkTargetValidator(deps: BotWorkTargetValidationDeps) {
  return (record: Pick<AgentSessionRecord, 'location'>, target: AgentJournalWorkTarget) =>
    validateBotWorkTarget(deps, record, target)
}

async function validateLocalStoreWorkTarget(
  deps: BotWorkTargetValidationDeps,
  store: NonNullable<ReturnType<BotWorkTargetValidationDeps['store']>>,
  targetHostId: ExecutionHostId,
  target: AgentJournalWorkTarget
): Promise<BotWorkTargetValidationResult> {
  const repos = store.getRepos()
  const setups = store.getProjectHostSetups?.() ?? []
  const hidden = indexHiddenProjects(repos, LOCAL_EXECUTION_HOST_ID)
  const bots = store.getBots?.() ?? []
  const botHomeIds = new Set(bots.map((bot) => bot.folderWorkspaceId))
  const projectGroups = store.getProjectGroups?.() ?? []
  const botsRoot = deps.botsRoot?.() ?? botsRootFolder()
  const botGroupIds = new Set(
    projectGroups.filter((group) => isBotsProjectGroup(group, botsRoot)).map((group) => group.id)
  )
  // On a paired-server runtime its own store holds repos as local; normalize lookups against it.
  const storeHostId: ExecutionHostId =
    targetHostId === deps.hostId ? LOCAL_EXECUTION_HOST_ID : targetHostId

  if (target.kind === 'project') {
    const repo = findProjectRepo(repos, setups, storeHostId, target)
    if (!repo || hidden.isRowHidden({ repoId: repo.id, hostId: storeHostId })) {
      return refuseUnavailable('The selected project is no longer available.')
    }
    if (isFolderRepo(repo)) {
      const folderWorktreeId = target.workspaceId ?? `${repo.id}::${repo.path}`
      const managed = await deps
        .showManagedTerminalWorkspace(`id:${folderWorktreeId}`, storeHostId)
        .catch(() => null)
      if (!managed || managed.repoId !== repo.id || managed.isArchived) {
        return refuseUnavailable('The selected folder project is no longer available.')
      }
      return {
        ok: true,
        placement: {
          mode: 'existing',
          worktreeSelector: `id:${managed.id}`,
          canonicalTarget: {
            kind: 'project',
            hostId: target.hostId,
            ...(target.projectId ? { projectId: target.projectId } : {}),
            repoId: repo.id,
            repoKind: 'folder',
            workspaceId: managed.id,
            workspaceKind: 'folder',
            displayName: repo.displayName,
            ...(target.hostLabel ? { hostLabel: target.hostLabel } : {})
          }
        }
      }
    }
    return {
      ok: true,
      placement: {
        mode: 'new-child',
        repoSelector: `id:${repo.id}`,
        canonicalTarget: {
          kind: 'project',
          hostId: target.hostId,
          ...(target.projectId ? { projectId: target.projectId } : {}),
          repoId: repo.id,
          repoKind: 'git',
          displayName: repo.displayName,
          ...(target.hostLabel ? { hostLabel: target.hostLabel } : {})
        }
      }
    }
  }

  const workspaceId = target.workspaceId
  if (!workspaceId) {
    return refuseUnavailable('The selected workspace is no longer available.')
  }
  const parsedKey = parseWorkspaceKey(workspaceId)
  if (parsedKey?.type === 'folder') {
    if (botHomeIds.has(parsedKey.folderWorkspaceId)) {
      return refuseUnavailable('Bot home workspaces cannot be targeted.')
    }
    const folder = (store.getFolderWorkspaces?.() ?? []).find(
      (entry) => entry.id === parsedKey.folderWorkspaceId
    )
    if (
      !folder ||
      folder.isArchived ||
      (folder.projectGroupId && botGroupIds.has(folder.projectGroupId))
    ) {
      return refuseUnavailable('The selected folder workspace is no longer available.')
    }
    if (folderWorkspaceHostId(folder) !== storeHostId) {
      return refuseUnavailable('The selected folder workspace does not belong to that host.')
    }
    const managed = await deps
      .showManagedTerminalWorkspace(`id:${folderWorkspaceKey(folder.id)}`, storeHostId)
      .catch(() => null)
    if (!managed) {
      return refuseUnavailable('The selected folder workspace is no longer available.')
    }
    return {
      ok: true,
      placement: {
        mode: 'existing',
        worktreeSelector: `id:${folderWorkspaceKey(folder.id)}`,
        canonicalTarget: {
          kind: 'workspace',
          hostId: target.hostId,
          workspaceId: folderWorkspaceKey(folder.id),
          workspaceKind: 'folder',
          displayName: folder.name,
          ...(target.projectName ? { projectName: target.projectName } : {}),
          ...(target.hostLabel ? { hostLabel: target.hostLabel } : {})
        }
      }
    }
  }

  const managed = await deps
    .showManagedTerminalWorkspace(`id:${workspaceId}`, storeHostId)
    .catch(() => null)
  if (!managed || managed.isArchived || store.getWorktreeMeta?.(managed.id)?.isArchived) {
    return refuseUnavailable('The selected workspace is no longer available.')
  }
  const repo = repos.find((entry) => entry.id === managed.repoId)
  if (
    !repo ||
    hidden.isRowHidden({ repoId: repo.id, hostId: storeHostId }) ||
    getRepoExecutionHostId(repo) !== storeHostId
  ) {
    return refuseUnavailable('The selected workspace project is no longer available.')
  }
  const isFolder = isFolderRepo(repo)
  return {
    ok: true,
    placement: {
      mode: 'existing',
      worktreeSelector: `id:${managed.id}`,
      canonicalTarget: {
        kind: 'workspace',
        hostId: target.hostId,
        ...(target.projectId ? { projectId: target.projectId } : {}),
        repoId: repo.id,
        repoKind: isFolder ? 'folder' : 'git',
        workspaceId: managed.id,
        workspaceKind: isFolder ? 'folder' : 'git-worktree',
        displayName: managed.displayName || managed.branch || repo.displayName,
        projectName: repo.displayName,
        ...(target.hostLabel ? { hostLabel: target.hostLabel } : {})
      }
    }
  }
}

function findProjectRepo(
  repos: readonly Repo[],
  setups: readonly ProjectHostSetup[],
  storeHostId: ExecutionHostId,
  target: AgentJournalWorkTarget
): Repo | undefined {
  if (target.repoId) {
    const byRepoId = repos.find(
      (repo) => repo.id === target.repoId && getRepoExecutionHostId(repo) === storeHostId
    )
    if (byRepoId) {
      return byRepoId
    }
  }
  if (target.projectId) {
    const setupRepoIds = new Set(
      setups
        .filter((setup) => setup.projectId === target.projectId && setup.hostId === storeHostId)
        .map((setup) => setup.repoId)
    )
    return repos.find(
      (repo) => setupRepoIds.has(repo.id) && getRepoExecutionHostId(repo) === storeHostId
    )
  }
  return undefined
}
