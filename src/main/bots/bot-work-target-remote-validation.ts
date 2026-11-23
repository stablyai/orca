import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host/execution-host'
import type { AgentJournalWorkTarget } from '../../shared/agent-session/work-target/agent-session-work-target'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import { indexHiddenProjects } from '../../shared/project/catalog/hidden-projects'
import { isFolderRepo } from '../../shared/repository/repo-kind'
import type { Repo } from '../../shared/repository/repo-types'
import {
  folderWorkspaceKey,
  parseWorkspaceKey
} from '../../shared/workspace/identity/workspace-scope'
import type { Worktree } from '../../shared/worktree/types'
import { resolveWorktreeCreateRoute } from '../workspaces/creation/worktree-create-execution-host-route'
import {
  refuseWorkTargetHostUnavailable,
  refuseWorkTargetUnavailable,
  resolveWorktreeIdentitySelector,
  type BotWorkTargetValidationResult
} from './bot-work-target-refusals'

export type { BotWorkTargetValidationResult } from './bot-work-target-refusals'

export type PairedServerWorkTargetValidationDeps = {
  resolveOrchestrationWorkerServer?: (selector: string) => Promise<{
    environmentId: string
    name: string
    pairingRevision?: number
    peerFingerprint?: string
  }>
  callOrchestrationWorkerServer?: (
    environmentId: string,
    method: string,
    params?: unknown,
    timeoutMs?: number,
    options?: { orchestrationRequestId?: string },
    pairingFence?: { expectedEnvironmentPairingRevision?: number }
  ) => Promise<unknown>
}

const REMOTE_VALIDATE_TIMEOUT_MS = 8_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isRemoteRepo(value: unknown): value is Repo {
  return isRecord(value) && typeof value.id === 'string' && typeof value.displayName === 'string'
}

function isRemoteWorktree(value: unknown): value is Worktree {
  return isRecord(value) && typeof value.id === 'string' && typeof value.repoId === 'string'
}

function isRemoteFolderWorkspace(value: unknown): value is FolderWorkspace {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
}

function readTypedArray<T>(reply: unknown, key: string, guard: (item: unknown) => item is T): T[] {
  if (!isRecord(reply)) {
    return []
  }
  const list = reply[key]
  return Array.isArray(list) ? list.filter(guard) : []
}

const refuseUnavailable = refuseWorkTargetUnavailable
const refuseHostUnavailable = refuseWorkTargetHostUnavailable

/** Validate a paired-server project or workspace target against live remote catalog RPCs. */
export async function validatePairedServerWorkTarget(
  deps: PairedServerWorkTargetValidationDeps,
  environmentId: string,
  target: AgentJournalWorkTarget
): Promise<BotWorkTargetValidationResult> {
  if (!deps.resolveOrchestrationWorkerServer || !deps.callOrchestrationWorkerServer) {
    return refuseHostUnavailable(
      'Remote server targeting is not supported by this Orca host configuration.'
    )
  }
  let server: {
    environmentId: string
    name: string
    pairingRevision?: number
    peerFingerprint?: string
  }
  try {
    server = await deps.resolveOrchestrationWorkerServer(environmentId)
  } catch {
    return refuseHostUnavailable('The paired server for the selected target is not connected.')
  }
  const fence =
    server.pairingRevision !== undefined
      ? { expectedEnvironmentPairingRevision: server.pairingRevision }
      : undefined
  const pairingPin = {
    ...(server.pairingRevision !== undefined
      ? { onExpectedPairingRevision: server.pairingRevision }
      : {}),
    ...(server.peerFingerprint ? { onExpectedPeerFingerprint: server.peerFingerprint } : {})
  }
  const callRemote = (method: string, params?: unknown) =>
    deps.callOrchestrationWorkerServer!(
      server.environmentId,
      method,
      params,
      REMOTE_VALIDATE_TIMEOUT_MS,
      undefined,
      fence
    )
  const remoteWorktreeSelector = (worktree: Worktree): string =>
    resolveWorktreeIdentitySelector(worktree, LOCAL_EXECUTION_HOST_ID)

  try {
    if (target.kind === 'project') {
      const remoteRepos = readTypedArray(await callRemote('repo.list', {}), 'repos', isRemoteRepo)
      const remoteHidden = indexHiddenProjects(remoteRepos, LOCAL_EXECUTION_HOST_ID)
      // Never replace an explicit stale repoId via projectId fallback.
      const repo = target.repoId
        ? remoteRepos.find(
            (entry) =>
              entry.id === target.repoId &&
              getRepoExecutionHostId(entry) === LOCAL_EXECUTION_HOST_ID
          )
        : target.projectId
          ? remoteRepos.find(
              (entry) =>
                entry.id === target.projectId &&
                getRepoExecutionHostId(entry) === LOCAL_EXECUTION_HOST_ID
            )
          : undefined
      if (!repo || remoteHidden.isRowHidden({ repoId: repo.id, hostId: LOCAL_EXECUTION_HOST_ID })) {
        return refuseUnavailable('The selected remote project is no longer available.')
      }
      if (isFolderRepo(repo)) {
        const listed = readTypedArray(
          await callRemote('worktree.list', { repo: `id:${repo.id}` }),
          'worktrees',
          isRemoteWorktree
        )
        const folderWorktree = listed.find(
          (entry) =>
            entry.repoId === repo.id &&
            !entry.isArchived &&
            (!target.workspaceInstanceId || entry.instanceId === target.workspaceInstanceId)
        )
        if (!folderWorktree) {
          return refuseUnavailable('The selected remote folder project is no longer available.')
        }
        return {
          ok: true,
          placement: {
            mode: 'existing',
            worktreeSelector: remoteWorktreeSelector(folderWorktree),
            ...(folderWorktree.instanceId
              ? { expectedWorkspaceInstanceId: folderWorktree.instanceId }
              : {}),
            onEnvironmentId: server.environmentId,
            ...pairingPin,
            canonicalTarget: {
              kind: 'project',
              hostId: `runtime:${server.environmentId}`,
              ...(target.projectId ? { projectId: target.projectId } : {}),
              repoId: repo.id,
              repoKind: 'folder',
              workspaceId: folderWorktree.id,
              ...(folderWorktree.instanceId
                ? { workspaceInstanceId: folderWorktree.instanceId }
                : {}),
              workspaceKind: 'folder',
              displayName: repo.displayName,
              hostLabel: server.name
            }
          }
        }
      }
      if (resolveWorktreeCreateRoute(repo).kind !== 'local') {
        return refuseUnavailable(
          'Creating a new workspace under that remote project is not supported; select an existing workspace instead.'
        )
      }
      return {
        ok: true,
        placement: {
          mode: 'new-top-level',
          repoSelector: `id:${repo.id}`,
          onEnvironmentId: server.environmentId,
          ...pairingPin,
          canonicalTarget: {
            kind: 'project',
            hostId: `runtime:${server.environmentId}`,
            ...(target.projectId ? { projectId: target.projectId } : {}),
            repoId: repo.id,
            repoKind: 'git',
            displayName: repo.displayName,
            hostLabel: server.name
          }
        }
      }
    }

    const workspaceId = target.workspaceId
    if (!workspaceId) {
      return refuseUnavailable('The selected remote workspace is no longer available.')
    }
    const parsedKey = parseWorkspaceKey(workspaceId)
    if (parsedKey?.type === 'folder') {
      const folders = readTypedArray(
        await callRemote('folderWorkspace.list'),
        'folderWorkspaces',
        isRemoteFolderWorkspace
      )
      const folder = folders.find(
        (entry) => entry.id === parsedKey.folderWorkspaceId && !entry.isArchived
      )
      if (!folder) {
        return refuseUnavailable('The selected remote folder workspace is no longer available.')
      }
      return {
        ok: true,
        placement: {
          mode: 'existing',
          worktreeSelector: `id:${folderWorkspaceKey(folder.id)}`,
          onEnvironmentId: server.environmentId,
          ...pairingPin,
          canonicalTarget: {
            kind: 'workspace',
            hostId: `runtime:${server.environmentId}`,
            workspaceId: folderWorkspaceKey(folder.id),
            workspaceKind: 'folder',
            displayName: folder.name,
            ...(target.projectName ? { projectName: target.projectName } : {}),
            hostLabel: server.name
          }
        }
      }
    }

    const [repoReply, worktreeReply] = await Promise.all([
      callRemote('repo.list', {}),
      callRemote('worktree.list', target.repoId ? { repo: `id:${target.repoId}` } : {})
    ])
    const remoteRepos = readTypedArray(repoReply, 'repos', isRemoteRepo)
    const remoteWorktrees = readTypedArray(worktreeReply, 'worktrees', isRemoteWorktree)
    const remoteHidden = indexHiddenProjects(remoteRepos, LOCAL_EXECUTION_HOST_ID)
    const worktree = remoteWorktrees.find(
      (entry) =>
        entry.id === workspaceId &&
        !entry.isArchived &&
        (!target.repoId || entry.repoId === target.repoId) &&
        (!target.workspaceInstanceId || entry.instanceId === target.workspaceInstanceId)
    )
    const worktreeHostId = worktree?.hostId ?? LOCAL_EXECUTION_HOST_ID
    const repo =
      worktree &&
      remoteRepos.find(
        (entry) => entry.id === worktree.repoId && getRepoExecutionHostId(entry) === worktreeHostId
      )
    if (
      !worktree ||
      !repo ||
      remoteHidden.isRowHidden({ repoId: repo.id, hostId: worktreeHostId })
    ) {
      return refuseUnavailable('The selected remote workspace is no longer available.')
    }
    const isFolder = isFolderRepo(repo)
    return {
      ok: true,
      placement: {
        mode: 'existing',
        worktreeSelector: remoteWorktreeSelector(worktree),
        ...(worktree.instanceId ? { expectedWorkspaceInstanceId: worktree.instanceId } : {}),
        onEnvironmentId: server.environmentId,
        ...pairingPin,
        canonicalTarget: {
          kind: 'workspace',
          hostId: `runtime:${server.environmentId}`,
          ...(target.projectId ? { projectId: target.projectId } : {}),
          repoId: repo.id,
          repoKind: isFolder ? 'folder' : 'git',
          workspaceId: worktree.id,
          ...(worktree.instanceId ? { workspaceInstanceId: worktree.instanceId } : {}),
          workspaceKind: isFolder ? 'folder' : 'git-worktree',
          displayName: worktree.displayName || worktree.branch || repo.displayName,
          projectName: repo.displayName,
          hostLabel: server.name
        }
      }
    }
  } catch {
    return refuseHostUnavailable(
      'Could not verify the selected target on its paired server; it may be offline.'
    )
  }
}
