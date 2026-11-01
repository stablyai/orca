import { dirname } from 'node:path'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session/lifecycle/agent-session-record'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host'
import { resolveQualifiedFolderWorkspaceResult } from '../../../shared/folder-workspace-execution-host'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import { isFolderRepo } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { beginWatcherInstall } from '../../ipc/watcher-removal-gate'
import { areWorktreePathsEqual } from '../../git/worktree-path-comparison'
import { resolveFloatingWorkspacePath } from '../../persistence/restoring-sessions/floating-workspace-normalization'
import { getAppEnvironment } from '../../../shared/app-environment'
import { resolveLocalProjectRuntimeForRepo } from '../../local-project-runtime-resolution'
import { localWorktreePathPresence } from '../../local-worktree-path-presence'
import {
  readAllWorktreeMetaForHost,
  readWorktreeMetaForHost
} from '../../persistence/host-qualified-worktree-meta'
import {
  isRuntimeFolderWorkspaceIdForRepo,
  getRuntimeFolderWorkspaceRootId
} from '../runtime-folder-workspace'
import { scanRuntimeWorktreesUntilNotOvertaken } from '../runtime-witnessed-worktree-scan'
import type { RuntimeStore } from '../runtime-store-contract'
import type { RuntimeWorktreeScanResult } from '../repo-worktree-resolution-scan'

export class StructuredWorkspaceUnavailable extends Error {
  constructor(readonly reason: 'removed' | 'unknown' | 'obsolete') {
    super('Chat workspace is unavailable')
  }
}

// A retained record addresses a resource; only that resource's owner can admit publication.
export async function prepareStructuredWorkspaceAuthority(
  store: RuntimeStore,
  location: AgentSessionExecutionLocation,
  scanRepo: (repo: Repo) => Promise<RuntimeWorktreeScanResult>
) {
  const { workspaceId, executionHostId } = location
  const folder = parseWorkspaceKey(workspaceId)
  let path: string
  let connectionId: string | undefined
  let registered: () => boolean
  let repo: Repo | undefined
  let affirmative = false
  if (folder?.type === 'folder') {
    if (!store.getFolderWorkspaces || !store.getProjectGroups) {
      throw new StructuredWorkspaceUnavailable('unknown')
    }
    const folderNow = () =>
      resolveQualifiedFolderWorkspaceResult(
        {
          folderWorkspaces: store.getFolderWorkspaces?.(),
          projectGroups: store.getProjectGroups?.(),
          repos: store.getRepos()
        },
        folder.folderWorkspaceId,
        executionHostId
      )
    const selected = folderNow()
    if (selected.kind !== 'selected') {
      throw new StructuredWorkspaceUnavailable(selected.kind === 'missing' ? 'removed' : 'unknown')
    }
    const row = selected.value.workspace
    path = row.folderPath
    connectionId = selected.value.connectionId ?? undefined
    registered = () => {
      const now = folderNow()
      return (
        now.kind === 'selected' &&
        now.value.workspace.id === row.id &&
        now.value.workspace.createdAt === row.createdAt &&
        now.value.workspace.projectGroupId === row.projectGroupId &&
        areWorktreePathsEqual(now.value.workspace.folderPath, path) &&
        now.value.connectionId === selected.value.connectionId
      )
    }
  } else if (isFloatingWorkspaceId(workspaceId)) {
    if (executionHostId !== LOCAL_EXECUTION_HOST_ID) {
      throw new StructuredWorkspaceUnavailable('unknown')
    }
    // The local floating namespace survives cwd loss through the existing launch fallback.
    const configured = store.getSettings().floatingTerminalCwd
    path = resolveFloatingWorkspacePath(configured || '~', getAppEnvironment().getPath('home'))
    registered = () => store.getSettings().floatingTerminalCwd === configured
  } else {
    const parsed = splitWorktreeIdForFilesystem(workspaceId)
    const owners = store
      .getRepos()
      .filter((row) => row.id === parsed?.repoId && getRepoExecutionHostId(row) === executionHostId)
    if (!parsed || owners.length !== 1) {
      throw new StructuredWorkspaceUnavailable('unknown')
    }
    repo = owners[0]
    const owner = repo
    path = isFolderRepo(owner) ? owner.path : parsed.worktreePath
    connectionId = getRepoSshConnectionId(owner) ?? undefined
    const runtimeNow = () => {
      const value = resolveLocalProjectRuntimeForRepo(store, owner)
      return value?.status === 'resolved' ? value.runtime.cacheKey : value?.repair.cacheKey
    }
    const runtimeKey = runtimeNow()
    const metaId =
      Object.keys(readAllWorktreeMetaForHost(store, executionHostId)).find((id) => {
        const candidate = splitWorktreeIdForFilesystem(id)
        return (
          candidate?.repoId === parsed.repoId &&
          (isFolderRepo(owner)
            ? id === workspaceId
            : areWorktreePathsEqual(candidate.worktreePath, path))
        )
      }) ?? workspaceId
    const metaNow = () => readWorktreeMetaForHost(store, metaId, executionHostId)
    const occupant = metaNow()
    affirmative = !!occupant
    if (
      isFolderRepo(owner) &&
      (!isRuntimeFolderWorkspaceIdForRepo(owner, workspaceId) ||
        (workspaceId !== getRuntimeFolderWorkspaceRootId(owner) && !occupant))
    ) {
      throw new StructuredWorkspaceUnavailable('removed')
    }
    registered = () => {
      const current = store
        .getRepos()
        .filter((row) => row.id === owner.id && getRepoExecutionHostId(row) === executionHostId)
      const meta = metaNow()
      return (
        current.length === 1 &&
        areWorktreePathsEqual(current[0].path, owner.path) &&
        isFolderRepo(current[0]) === isFolderRepo(owner) &&
        (getRepoSshConnectionId(current[0]) ?? undefined) === connectionId &&
        runtimeNow() === runtimeKey &&
        meta?.instanceId === occupant?.instanceId &&
        !!meta === !!occupant
      )
    }
  }
  const install = beginWatcherInstall(path, connectionId)
  try {
    if (repo && !isFolderRepo(repo)) {
      const scan = await scanRuntimeWorktreesUntilNotOvertaken(store, repo, (owner) =>
        withTimeout(scanRepo(owner), 5_000, { ok: false, worktrees: [] })
      )
      if (scan.superseded) {
        throw new StructuredWorkspaceUnavailable('obsolete')
      }
      const listed = scan.ok && scan.worktrees.some((row) => areWorktreePathsEqual(row.path, path))
      if (!listed) {
        if (
          scan.ok &&
          executionHostId === LOCAL_EXECUTION_HOST_ID &&
          !location.wslDistro &&
          scan.worktrees.some(
            (row) => row.isMainWorktree && areWorktreePathsEqual(row.path, repo!.path)
          )
        ) {
          const [exists, repoPresent, parentPresent] = await Promise.all([
            localWorktreePathPresence(path),
            localWorktreePathPresence(repo.path),
            localWorktreePathPresence(dirname(path))
          ])
          if (
            exists === 'missing' &&
            repoPresent === 'directory' &&
            parentPresent === 'directory'
          ) {
            throw new StructuredWorkspaceUnavailable('removed')
          }
        }
        if (!affirmative) {
          throw new StructuredWorkspaceUnavailable('unknown')
        }
      }
    }
    const current = () => install.isCurrent() && registered()
    const check = () => {
      if (!current()) {
        throw new StructuredWorkspaceUnavailable('obsolete')
      }
    }
    check()
    return { current, check, release: install }
  } catch (error) {
    install()
    throw error
  }
}
