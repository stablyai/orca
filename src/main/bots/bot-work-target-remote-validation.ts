import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host/execution-host'
import {
  matchesPairedServerWorkTargetIdentity,
  type AgentJournalWorkTarget
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
import { resolveWorktreeCreateRoute } from '../workspaces/creation/worktree-create-execution-host-route'
import {
  refuseWorkTargetExpired,
  refuseWorkTargetHostUnavailable,
  refuseWorkTargetUnavailable,
  resolveWorktreeIdentitySelector,
  type BotWorkTargetValidationResult
} from './bot-work-target-refusals'

export type { BotWorkTargetValidationResult } from './bot-work-target-refusals'

export type ResolvedPairedServer = {
  environmentId: string
  name: string
  pairingRevision?: number
  peerFingerprint?: string
}

export type PairedServerWorkTargetValidationDeps = {
  resolveOrchestrationWorkerServer?: (selector: string) => Promise<ResolvedPairedServer>
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isRemoteRepo = (v: unknown): v is Repo =>
  isRecord(v) && typeof v.id === 'string' && typeof v.displayName === 'string'
const isRemoteWorktree = (v: unknown): v is Worktree =>
  isRecord(v) && typeof v.id === 'string' && typeof v.repoId === 'string'
const isRemoteFolderWorkspace = (v: unknown): v is FolderWorkspace =>
  isRecord(v) && typeof v.id === 'string' && typeof v.name === 'string'

function readTypedArray<T>(reply: unknown, key: string, guard: (item: unknown) => item is T): T[] {
  const list = isRecord(reply) ? reply[key] : undefined
  return Array.isArray(list) ? list.filter(guard) : []
}

const isPairingChangedError = (error: unknown): boolean =>
  isRecord(error) &&
  (error.code === 'server_pairing_changed' || error.code === 'runtime_environment_changed')

const refusePairingExpired = (serverName: string): BotWorkTargetValidationResult =>
  refuseWorkTargetExpired(
    `The selected target on ${serverName} expired because its paired server changed or was re-paired.`
  )

/** Validate a paired-server project or workspace target against live remote catalog RPCs. */
export async function validatePairedServerWorkTarget(
  deps: PairedServerWorkTargetValidationDeps,
  environmentId: string,
  target: AgentJournalWorkTarget
): Promise<BotWorkTargetValidationResult> {
  if (!deps.resolveOrchestrationWorkerServer || !deps.callOrchestrationWorkerServer) {
    return refuseWorkTargetHostUnavailable(
      'Remote server targeting is not supported by this Orca host configuration.'
    )
  }
  let server: ResolvedPairedServer
  try {
    server = await deps.resolveOrchestrationWorkerServer(environmentId)
  } catch {
    return refuseWorkTargetHostUnavailable(
      'The paired server for the selected target is not connected.'
    )
  }
  // Enforce any host-authored pairing pin before touching the paired server over RPC.
  if (
    !matchesPairedServerWorkTargetIdentity(server, {
      environmentId,
      pairingRevision: target.pairingRevision,
      peerFingerprint: target.peerFingerprint
    })
  ) {
    return refusePairingExpired(server.name)
  }
  const rev = target.pairingRevision ?? server.pairingRevision
  const fp = target.peerFingerprint ?? server.peerFingerprint
  const fence = rev !== undefined ? { expectedEnvironmentPairingRevision: rev } : undefined
  const callRemote = (method: string, params?: unknown) =>
    deps.callOrchestrationWorkerServer!(
      server.environmentId,
      method,
      params,
      REMOTE_VALIDATE_TIMEOUT_MS,
      undefined,
      fence
    )
  const pairedResult = (
    placement:
      | { mode: 'new-top-level'; repoSelector: string }
      | { mode: 'existing'; worktreeSelector: string; expectedWorkspaceInstanceId?: string },
    canonical: Omit<
      AgentJournalWorkTarget,
      'hostId' | 'hostLabel' | 'pairingRevision' | 'peerFingerprint'
    >
  ): BotWorkTargetValidationResult => ({
    ok: true,
    placement: {
      ...placement,
      onEnvironmentId: server.environmentId,
      ...(rev !== undefined ? { onExpectedPairingRevision: rev } : {}),
      ...(fp ? { onExpectedPeerFingerprint: fp } : {}),
      canonicalTarget: {
        ...canonical,
        hostId: `runtime:${server.environmentId}`,
        hostLabel: server.name,
        ...(rev !== undefined ? { pairingRevision: rev } : {}),
        ...(fp ? { peerFingerprint: fp } : {})
      }
    }
  })

  try {
    if (target.kind === 'project') {
      const remoteRepos = readTypedArray(await callRemote('repo.list', {}), 'repos', isRemoteRepo)
      const remoteHidden = indexHiddenProjects(remoteRepos, LOCAL_EXECUTION_HOST_ID)
      // Never replace an explicit stale repoId via projectId fallback.
      const lookupId = target.repoId ?? target.projectId
      const repo = lookupId
        ? remoteRepos.find(
            (entry) =>
              entry.id === lookupId && getRepoExecutionHostId(entry) === LOCAL_EXECUTION_HOST_ID
          )
        : undefined
      if (!repo || remoteHidden.isRowHidden({ repoId: repo.id, hostId: LOCAL_EXECUTION_HOST_ID })) {
        return refuseWorkTargetUnavailable('The selected remote project is no longer available.')
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
          return refuseWorkTargetUnavailable(
            'The selected remote folder project is no longer available.'
          )
        }
        return pairedResult(
          {
            mode: 'existing',
            worktreeSelector: resolveWorktreeIdentitySelector(
              folderWorktree,
              LOCAL_EXECUTION_HOST_ID
            ),
            ...(folderWorktree.instanceId
              ? { expectedWorkspaceInstanceId: folderWorktree.instanceId }
              : {})
          },
          {
            kind: 'project',
            ...(target.projectId ? { projectId: target.projectId } : {}),
            repoId: repo.id,
            repoKind: 'folder',
            workspaceId: folderWorktree.id,
            ...(folderWorktree.instanceId
              ? { workspaceInstanceId: folderWorktree.instanceId }
              : {}),
            workspaceKind: 'folder',
            displayName: repo.displayName
          }
        )
      }
      if (resolveWorktreeCreateRoute(repo).kind !== 'local') {
        return refuseWorkTargetUnavailable(
          'Creating a new workspace under that remote project is not supported; select an existing workspace instead.'
        )
      }
      return pairedResult(
        { mode: 'new-top-level', repoSelector: `id:${repo.id}` },
        {
          kind: 'project',
          ...(target.projectId ? { projectId: target.projectId } : {}),
          repoId: repo.id,
          repoKind: 'git',
          displayName: repo.displayName
        }
      )
    }

    const workspaceId = target.workspaceId
    if (!workspaceId) {
      return refuseWorkTargetUnavailable('The selected remote workspace is no longer available.')
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
        return refuseWorkTargetUnavailable(
          'The selected remote folder workspace is no longer available.'
        )
      }
      return pairedResult(
        { mode: 'existing', worktreeSelector: `id:${folderWorkspaceKey(folder.id)}` },
        {
          kind: 'workspace',
          workspaceId: folderWorkspaceKey(folder.id),
          workspaceKind: 'folder',
          displayName: folder.name,
          ...(target.projectName ? { projectName: target.projectName } : {})
        }
      )
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
      return refuseWorkTargetUnavailable('The selected remote workspace is no longer available.')
    }
    const isFolder = isFolderRepo(repo)
    return pairedResult(
      {
        mode: 'existing',
        worktreeSelector: resolveWorktreeIdentitySelector(worktree, LOCAL_EXECUTION_HOST_ID),
        ...(worktree.instanceId ? { expectedWorkspaceInstanceId: worktree.instanceId } : {})
      },
      {
        kind: 'workspace',
        ...(target.projectId ? { projectId: target.projectId } : {}),
        repoId: repo.id,
        repoKind: isFolder ? 'folder' : 'git',
        workspaceId: worktree.id,
        ...(worktree.instanceId ? { workspaceInstanceId: worktree.instanceId } : {}),
        workspaceKind: isFolder ? 'folder' : 'git-worktree',
        displayName: worktree.displayName || worktree.branch || repo.displayName,
        projectName: repo.displayName
      }
    )
  } catch (error) {
    if (isPairingChangedError(error)) {
      return refusePairingExpired(server.name)
    }
    return refuseWorkTargetHostUnavailable(
      'Could not verify the selected target on its paired server; it may be offline.'
    )
  }
}
