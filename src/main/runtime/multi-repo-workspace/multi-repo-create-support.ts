import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host'
import {
  MULTI_REPO_SYSTEM_GROUP_NAME,
  MULTI_REPO_WORKSPACE_MAX_MEMBERS,
  MULTI_REPO_WORKSPACE_MIN_MEMBERS,
  MultiRepoWorkspaceError,
  isMultiRepoWorkspaceSettled
} from '../../../shared/multi-repo-workspace'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { isFolderRepo } from '../../../shared/repo-kind'
import { isWslUncPath } from '../../../shared/wsl-paths'
import type { Repo } from '../../../shared/repo-types'
import { bucketMultiRepoMemberCount } from '../../../shared/telemetry-multi-repo-workspace-event-schemas'
import { track } from '../../telemetry/client'
import type { MultiRepoWorkspacePort } from './multi-repo-workspace-port'

export function validateMultiRepoRepos(
  port: MultiRepoWorkspacePort,
  repoIds: readonly string[]
): Repo[] {
  if (
    repoIds.length < MULTI_REPO_WORKSPACE_MIN_MEMBERS ||
    repoIds.length > MULTI_REPO_WORKSPACE_MAX_MEMBERS ||
    new Set(repoIds).size !== repoIds.length
  ) {
    throw new MultiRepoWorkspaceError(
      'multi_repo_invalid_members',
      'Pick between 2 and 12 different projects.'
    )
  }
  const all = port.requireStore().getRepos()
  return repoIds.map((repoId) => {
    const repo = all.find((entry) => entry.id === repoId)
    if (!repo) {
      throw new MultiRepoWorkspaceError('multi_repo_repo_not_found', 'Project was not found.', {
        repoId
      })
    }
    if (isFolderRepo(repo)) {
      throw new MultiRepoWorkspaceError('multi_repo_repo_not_git', 'Folder projects cannot join.', {
        repoId
      })
    }
    if (getRepoRoutingConnectionId(repo) || getRepoExecutionHostId(repo).startsWith('ssh:')) {
      throw new MultiRepoWorkspaceError(
        'multi_repo_repo_direct_ssh',
        'Direct SSH projects cannot join a multi-repo workspace.',
        { repoId }
      )
    }
    if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
      throw new MultiRepoWorkspaceError(
        'multi_repo_mixed_hosts',
        'All projects must live on this host.',
        { repoId }
      )
    }
    if (isWslUncPath(repo.path)) {
      throw new MultiRepoWorkspaceError(
        'multi_repo_repo_wsl',
        'WSL projects cannot join a multi-repo workspace yet.',
        { repoId }
      )
    }
    return repo
  })
}

export async function ensureMultiRepoSystemGroup(
  port: MultiRepoWorkspacePort,
  workspaceDir: string
): Promise<{ id: string }> {
  const existing = port
    .requireStore()
    .getProjectGroups?.()
    .find(
      (group) =>
        group.name === MULTI_REPO_SYSTEM_GROUP_NAME &&
        !group.connectionId &&
        group.parentPath !== null &&
        group.parentPath !== undefined &&
        normalizeRuntimePathForComparison(group.parentPath) ===
          normalizeRuntimePathForComparison(workspaceDir)
    )
  return (
    existing ??
    (await port.createProjectGroup({
      name: MULTI_REPO_SYSTEM_GROUP_NAME,
      parentPath: workspaceDir,
      createdFrom: 'manual'
    }))
  )
}

export function reportMultiRepoCreated(
  port: MultiRepoWorkspacePort,
  folderWorkspaceId: string,
  startedAt: number
): void {
  const workspace = port
    .requireStore()
    .getFolderWorkspaces?.()
    .find((entry) => entry.id === folderWorkspaceId)
  const multiRepo = workspace?.multiRepo
  if (!multiRepo || !isMultiRepoWorkspaceSettled(multiRepo)) {
    return
  }
  track('multi_repo_workspace_created', {
    member_count_bucket: bucketMultiRepoMemberCount(multiRepo.members.length),
    ready_count: multiRepo.members.filter((member) => member.state === 'ready').length,
    failed_count: multiRepo.members.filter((member) => member.state === 'failed').length,
    total_duration_ms: Date.now() - startedAt,
    execution_host: 'local'
  })
}
