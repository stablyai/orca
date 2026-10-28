import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { MultiRepoWorkspaceError } from '../../../shared/multi-repo-workspace'
import { worktreeRowTarget } from '../../persistence/host-qualified-worktree-meta'
import { recordMultiRepoMemberLineage } from './multi-repo-member-adoption'
import type { MultiRepoWorkspacePort } from './multi-repo-workspace-port'
import {
  requireMultiRepoMember,
  requireMultiRepoWorkspace,
  writeMultiRepoRecord
} from './multi-repo-workspace-record'

export async function removeMultiRepoMember(
  port: MultiRepoWorkspacePort,
  folderWorkspaceId: string,
  memberId: string
): Promise<FolderWorkspace> {
  const store = port.requireStore()
  const member = requireMultiRepoMember(
    requireMultiRepoWorkspace(store, folderWorkspaceId).multiRepo,
    memberId
  )
  if (member.state !== 'failed' && member.state !== 'interrupted') {
    throw new MultiRepoWorkspaceError(
      'multi_repo_member_not_removable',
      'Only failed or interrupted members can be removed. Nothing on disk is deleted.'
    )
  }
  const updated = writeMultiRepoRecord(store, folderWorkspaceId, (current) => ({
    ...current,
    members: current.members.filter((entry) => entry.memberId !== memberId)
  }))
  port.notifyChanged()
  return updated ?? requireMultiRepoWorkspace(store, folderWorkspaceId)
}

export async function detachMultiRepoMember(
  port: MultiRepoWorkspacePort,
  folderWorkspaceId: string,
  memberId: string
): Promise<FolderWorkspace> {
  const store = port.requireStore()
  const workspace = requireMultiRepoWorkspace(store, folderWorkspaceId)
  const member = requireMultiRepoMember(workspace.multiRepo, memberId)
  if (member.state !== 'ready' || !member.worktreeId) {
    throw new MultiRepoWorkspaceError(
      'multi_repo_member_not_detachable',
      'Only a ready member can be removed from the workspace.'
    )
  }
  const target = worktreeRowTarget(store, { id: member.worktreeId })
  if (target) {
    store.removeWorktreeLineage?.(target)
  }
  const updated = writeMultiRepoRecord(store, folderWorkspaceId, (current) => ({
    ...current,
    members: current.members.filter((entry) => entry.memberId !== memberId),
    detachedMembers: [...(current.detachedMembers ?? []), member]
  }))
  port.notifyChanged()
  return updated ?? requireMultiRepoWorkspace(store, folderWorkspaceId)
}

export async function attachMultiRepoMember(
  port: MultiRepoWorkspacePort,
  folderWorkspaceId: string,
  memberId: string
): Promise<FolderWorkspace> {
  const store = port.requireStore()
  const workspace = requireMultiRepoWorkspace(store, folderWorkspaceId)
  const member = workspace.multiRepo.detachedMembers?.find((entry) => entry.memberId === memberId)
  const worktreeId = member?.worktreeId
  if (!member || !worktreeId || !store.getWorktreeMeta(worktreeId)) {
    throw new MultiRepoWorkspaceError(
      'multi_repo_member_not_attachable',
      'This workspace cannot be restored; its worktree no longer exists.'
    )
  }
  recordMultiRepoMemberLineage(port, workspace, worktreeId, member.worktreeInstanceId)
  const updated = writeMultiRepoRecord(store, folderWorkspaceId, (current) => ({
    ...current,
    members: [...current.members, member],
    detachedMembers: (current.detachedMembers ?? []).filter((entry) => entry.memberId !== memberId)
  }))
  port.notifyChanged()
  return updated ?? requireMultiRepoWorkspace(store, folderWorkspaceId)
}
