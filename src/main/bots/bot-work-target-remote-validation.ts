import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host/execution-host'
import {
  refuse,
  type AgentSessionWireRefusal
} from '../../shared/agent-session/failures/agent-session-wire-refusals'
import type {
  AgentJournalWorkTarget,
  ResolvedBotWorkTargetPlacement
} from '../../shared/agent-session/work-target/agent-session-work-target'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import { indexHiddenProjects } from '../../shared/project/catalog/hidden-projects'
import { isFolderRepo } from '../../shared/repository/repo-kind'
import type { Repo } from '../../shared/repository/repo-types'
import {
  folderWorkspaceKey,
  parseWorkspaceKey
} from '../../shared/workspace/identity/workspace-scope'
import type { Worktree } from '../../shared/worktree/types'

export type BotWorkTargetValidationResult =
  | { ok: true; placement: ResolvedBotWorkTargetPlacement }
  | { ok: false; refusal: AgentSessionWireRefusal }

export type PairedServerWorkTargetValidationDeps = {
  resolveOrchestrationWorkerServer?: (
    selector: string
  ) => Promise<{ environmentId: string; name: string; pairingRevision?: number }>
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

function refuseUnavailable(message: string): BotWorkTargetValidationResult {
  return {
    ok: false,
    refusal: refuse('agent_session_operation_invalid', { reason: 'workTargetUnavailable' }, message)
  }
}

function refuseHostUnavailable(message: string): BotWorkTargetValidationResult {
  return {
    ok: false,
    refusal: refuse(
      'agent_session_operation_invalid',
      { reason: 'workTargetHostUnavailable' },
      message
    )
  }
}

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
  let server: { environmentId: string; name: string; pairingRevision?: number }
  try {
    server = await deps.resolveOrchestrationWorkerServer(environmentId)
  } catch {
    return refuseHostUnavailable('The paired server for the selected target is not connected.')
  }
  const fence =
    server.pairingRevision !== undefined
      ? { expectedEnvironmentPairingRevision: server.pairingRevision }
      : undefined
  const callRemote = (method: string, params?: unknown) =>
    deps.callOrchestrationWorkerServer!(
      server.environmentId,
      method,
      params,
      REMOTE_VALIDATE_TIMEOUT_MS,
      undefined,
      fence
    )

  try {
    if (target.kind === 'project') {
      const remoteRepos = readTypedArray(await callRemote('repo.list', {}), 'repos', isRemoteRepo)
      const remoteHidden = indexHiddenProjects(remoteRepos, LOCAL_EXECUTION_HOST_ID)
      const repo = remoteRepos.find(
        (entry) =>
          (target.repoId && entry.id === target.repoId) ||
          (target.projectId && entry.id === target.projectId)
      )
      if (!repo || remoteHidden.isRowHidden({ repoId: repo.id, hostId: LOCAL_EXECUTION_HOST_ID })) {
        return refuseUnavailable('The selected remote project is no longer available.')
      }
      if (isFolderRepo(repo)) {
        const listed = readTypedArray(
          await callRemote('worktree.list', { repo: `id:${repo.id}` }),
          'worktrees',
          isRemoteWorktree
        )
        const folderWorktree = listed.find((entry) => entry.repoId === repo.id && !entry.isArchived)
        if (!folderWorktree) {
          return refuseUnavailable('The selected remote folder project is no longer available.')
        }
        return {
          ok: true,
          placement: {
            mode: 'existing',
            worktreeSelector: `id:${folderWorktree.id}`,
            onEnvironmentId: server.environmentId,
            canonicalTarget: {
              kind: 'project',
              hostId: `runtime:${server.environmentId}`,
              ...(target.projectId ? { projectId: target.projectId } : {}),
              repoId: repo.id,
              repoKind: 'folder',
              workspaceId: folderWorktree.id,
              workspaceKind: 'folder',
              displayName: repo.displayName,
              hostLabel: server.name
            }
          }
        }
      }
      return {
        ok: true,
        placement: {
          mode: 'new-child',
          repoSelector: `id:${repo.id}`,
          onEnvironmentId: server.environmentId,
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
    const worktree = remoteWorktrees.find((entry) => entry.id === workspaceId && !entry.isArchived)
    const repo = worktree && remoteRepos.find((entry) => entry.id === worktree.repoId)
    if (
      !worktree ||
      !repo ||
      remoteHidden.isRowHidden({ repoId: repo.id, hostId: LOCAL_EXECUTION_HOST_ID })
    ) {
      return refuseUnavailable('The selected remote workspace is no longer available.')
    }
    const isFolder = isFolderRepo(repo)
    return {
      ok: true,
      placement: {
        mode: 'existing',
        worktreeSelector: `id:${worktree.id}`,
        onEnvironmentId: server.environmentId,
        canonicalTarget: {
          kind: 'workspace',
          hostId: `runtime:${server.environmentId}`,
          ...(target.projectId ? { projectId: target.projectId } : {}),
          repoId: repo.id,
          repoKind: isFolder ? 'folder' : 'git',
          workspaceId: worktree.id,
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
