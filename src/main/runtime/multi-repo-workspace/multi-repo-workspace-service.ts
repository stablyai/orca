import { randomUUID } from 'node:crypto'
import { rmdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import {
  MULTI_REPO_WORKSPACE_CREATE_CONCURRENCY,
  MultiRepoWorkspaceError,
  type MultiRepoDeleteInspection,
  type MultiRepoDeleteResult,
  type MultiRepoMember,
  type MultiRepoWorkspace
} from '../../../shared/multi-repo-workspace'
import type { WorkspaceCreatorProvenance } from '../../../shared/worktree/types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { sanitizeWorktreeName } from '../../ipc/worktree-logic'
import { track } from '../../telemetry/client'
import {
  deleteMultiRepoWorkspace,
  inspectMultiRepoDelete,
  type MultiRepoDeleteRequest
} from './multi-repo-workspace-delete'
import { classifyMultiRepoMemberFailure } from './multi-repo-member-failure'
import { allocateMemberDirNames, allocateMultiRepoRoot } from './multi-repo-root-allocation'
import type { MultiRepoWorkspacePort } from './multi-repo-workspace-port'
import {
  patchMultiRepoMember,
  requireMultiRepoMember,
  requireMultiRepoWorkspace
} from './multi-repo-workspace-record'

import {
  removeMultiRepoMember,
  detachMultiRepoMember,
  attachMultiRepoMember
} from './multi-repo-member-actions'
import { recordMultiRepoMemberLineage, tryAdoptMultiRepoMember } from './multi-repo-member-adoption'
import {
  ensureMultiRepoSystemGroup,
  reportMultiRepoCreated,
  validateMultiRepoRepos
} from './multi-repo-create-support'

export type MultiRepoWorkspaceCreateInput = {
  name: string
  members: { repoId: string; branchName?: string; baseRef?: string }[]
  clientMutationId?: string
  createdWithAgent?: TuiAgent
  creatorProvenance?: WorkspaceCreatorProvenance
}

export class MultiRepoWorkspaceService {
  private readonly activeMembers = new Set<string>()
  private readonly createsByMutationId = new Map<string, Promise<FolderWorkspace>>()

  constructor(private readonly port: MultiRepoWorkspacePort) {}

  create(input: MultiRepoWorkspaceCreateInput): Promise<FolderWorkspace> {
    const key = input.clientMutationId
    if (!key) {
      return this.createOnce(input)
    }
    const existing = this.createsByMutationId.get(key)
    if (existing) {
      return existing
    }
    const created = this.createOnce(input)
    this.createsByMutationId.set(key, created)
    created.catch(() => this.createsByMutationId.delete(key))
    return created
  }

  async retryMember(folderWorkspaceId: string, memberId: string): Promise<FolderWorkspace> {
    const store = this.port.requireStore()
    const member = requireMultiRepoMember(
      requireMultiRepoWorkspace(store, folderWorkspaceId).multiRepo,
      memberId
    )
    if (member.state !== 'failed' && member.state !== 'interrupted') {
      throw new MultiRepoWorkspaceError(
        'multi_repo_member_not_retryable',
        'Only failed or interrupted members can be retried.'
      )
    }
    if (this.activeMembers.has(memberId)) {
      throw new MultiRepoWorkspaceError(
        'multi_repo_member_not_retryable',
        'This member is already being created.'
      )
    }
    patchMultiRepoMember(store, folderWorkspaceId, memberId, (current) => ({
      ...current,
      state: 'queued',
      failure: undefined
    }))
    this.port.notifyChanged()
    await this.runMembers(folderWorkspaceId, [memberId], { reportRetry: true })
    return requireMultiRepoWorkspace(store, folderWorkspaceId)
  }

  removeMember(folderWorkspaceId: string, memberId: string): Promise<FolderWorkspace> {
    return removeMultiRepoMember(this.port, folderWorkspaceId, memberId)
  }

  detachMember(folderWorkspaceId: string, memberId: string): Promise<FolderWorkspace> {
    return detachMultiRepoMember(this.port, folderWorkspaceId, memberId)
  }

  attachMember(folderWorkspaceId: string, memberId: string): Promise<FolderWorkspace> {
    return attachMultiRepoMember(this.port, folderWorkspaceId, memberId)
  }

  inspectDelete(folderWorkspaceId: string): Promise<MultiRepoDeleteInspection> {
    return inspectMultiRepoDelete(this.port, folderWorkspaceId)
  }

  delete(request: MultiRepoDeleteRequest): Promise<MultiRepoDeleteResult> {
    return deleteMultiRepoWorkspace(this.port, request, (memberId) =>
      this.activeMembers.has(memberId)
    )
  }

  private async createOnce(input: MultiRepoWorkspaceCreateInput): Promise<FolderWorkspace> {
    const store = this.port.requireStore()
    const repos = validateMultiRepoRepos(
      this.port,
      input.members.map((member) => member.repoId)
    )
    const workspaceDir = store.getSettings().workspaceDir
    if (!isAbsolute(workspaceDir)) {
      throw new MultiRepoWorkspaceError(
        'multi_repo_root_unavailable',
        'Set an absolute workspace directory in Settings first.'
      )
    }
    let defaultBranch: string
    try {
      defaultBranch = sanitizeWorktreeName(input.name)
    } catch {
      throw new MultiRepoWorkspaceError(
        'multi_repo_root_unavailable',
        'Choose a workspace name with letters or numbers.'
      )
    }
    const group = await ensureMultiRepoSystemGroup(this.port, workspaceDir)
    const rootPath = await allocateMultiRepoRoot(workspaceDir, input.name)
    let workspace: FolderWorkspace
    try {
      workspace = await this.port.createFolderWorkspace({
        projectGroupId: group.id,
        name: input.name.trim(),
        folderPath: rootPath,
        connectionId: null,
        ...(input.creatorProvenance ? { creatorProvenance: input.creatorProvenance } : {}),
        ...(input.createdWithAgent ? { createdWithAgent: input.createdWithAgent } : {})
      })
    } catch (error) {
      await rmdir(rootPath).catch(() => {})
      throw error
    }
    const dirNames = allocateMemberDirNames(repos.map((repo) => repo.path))
    const members: MultiRepoMember[] = input.members.map((requested, index) => ({
      memberId: randomUUID(),
      repoId: requested.repoId,
      dirName: dirNames[index],
      branchName: requested.branchName ?? defaultBranch,
      ...(requested.branchName ? { branchExplicit: true } : {}),
      ...(requested.baseRef ? { baseRef: requested.baseRef } : {}),
      state: 'queued',
      attempts: 0
    }))
    const multiRepo: MultiRepoWorkspace = {
      version: 1,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      rootOwnedByOrca: true,
      members,
      ...(input.createdWithAgent ? { pendingAgentStart: true } : {})
    }
    const stored = store.updateFolderWorkspace?.(workspace.id, { multiRepo })
    if (!stored) {
      await this.port.deleteFolderWorkspace(workspace.id)
      await rmdir(rootPath).catch(() => {})
      throw new MultiRepoWorkspaceError(
        'multi_repo_root_unavailable',
        'Could not record the workspace.'
      )
    }
    this.port.notifyChanged()
    const startedAt = Date.now()
    void this.runMembers(
      workspace.id,
      members.map((member) => member.memberId),
      { startedAt }
    ).catch((error: unknown) => {
      console.warn('[multi-repo-workspace] create run failed', error)
    })
    return stored
  }

  private async runMembers(
    folderWorkspaceId: string,
    memberIds: readonly string[],
    options: { startedAt?: number; reportRetry?: boolean }
  ): Promise<void> {
    const queue = [...memberIds]
    const worker = async (): Promise<void> => {
      for (let memberId = queue.shift(); memberId; memberId = queue.shift()) {
        await this.runMember(folderWorkspaceId, memberId, options.reportRetry === true)
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(MULTI_REPO_WORKSPACE_CREATE_CONCURRENCY, queue.length) },
        worker
      )
    )
    if (options.startedAt !== undefined) {
      reportMultiRepoCreated(this.port, folderWorkspaceId, options.startedAt)
    }
  }

  private async runMember(
    folderWorkspaceId: string,
    memberId: string,
    reportRetry: boolean
  ): Promise<void> {
    const store = this.port.requireStore()
    this.activeMembers.add(memberId)
    try {
      const workspace = requireMultiRepoWorkspace(store, folderWorkspaceId)
      const member = requireMultiRepoMember(workspace.multiRepo, memberId)
      patchMultiRepoMember(store, folderWorkspaceId, memberId, (current) => ({
        ...current,
        state: 'creating',
        attempts: current.attempts + 1
      }))
      this.port.notifyChanged()
      const adopted =
        member.attempts > 0 || member.worktreeId
          ? await tryAdoptMultiRepoMember(this.port, workspace, member)
          : null
      if (!adopted && member.worktreeId) {
        // A member that already owns a worktree must never get a second one created over it.
        throw new Error(`Could not adopt existing worktree ${member.worktreeId}`)
      }
      if (adopted) {
        this.markReady(folderWorkspaceId, memberId, adopted)
      } else {
        const result = await this.port.createWorktree({
          repoSelector: member.repoId,
          name: workspace.name,
          ...(member.branchExplicit ? { branchNameOverride: member.branchName } : {}),
          ...(member.baseRef ? { baseBranch: member.baseRef } : {}),
          placement: { parentDir: workspace.folderPath, leafName: member.dirName },
          creationId: member.memberId,
          activate: false,
          ...(workspace.creatorProvenance ? { creatorProvenance: workspace.creatorProvenance } : {})
        })
        recordMultiRepoMemberLineage(
          this.port,
          workspace,
          result.worktree.id,
          result.worktree.instanceId
        )
        this.markReady(folderWorkspaceId, memberId, {
          worktreeId: result.worktree.id,
          instanceId: result.worktree.instanceId,
          branch: result.worktree.branch
        })
      }
      if (reportRetry) {
        track('multi_repo_member_retry', { result: 'ready' })
      }
    } catch (error) {
      patchMultiRepoMember(store, folderWorkspaceId, memberId, (current) => ({
        ...current,
        state: 'failed',
        failure: classifyMultiRepoMemberFailure(error)
      }))
      if (reportRetry) {
        track('multi_repo_member_retry', { result: 'failed' })
      }
    } finally {
      this.activeMembers.delete(memberId)
      this.port.notifyChanged()
    }
  }

  private markReady(
    folderWorkspaceId: string,
    memberId: string,
    created: { worktreeId: string; instanceId?: string; branch?: string }
  ): void {
    const store = this.port.requireStore()
    patchMultiRepoMember(store, folderWorkspaceId, memberId, (current) => ({
      ...current,
      state: 'ready',
      failure: undefined,
      worktreeId: created.worktreeId,
      ...(created.instanceId ? { worktreeInstanceId: created.instanceId } : {}),
      ...(created.branch ? { branchName: created.branch.replace(/^refs\/heads\//, '') } : {})
    }))
  }
}
