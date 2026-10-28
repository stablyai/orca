import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import {
  MultiRepoWorkspaceError,
  type MultiRepoMember,
  type MultiRepoWorkspace
} from '../../../shared/multi-repo-workspace'
import type { RuntimeStore } from '../runtime-store-contract'

export type MultiRepoRecordStore = Pick<
  RuntimeStore,
  'getFolderWorkspaces' | 'updateFolderWorkspace'
>

export function listMultiRepoFolderWorkspaces(
  store: Pick<RuntimeStore, 'getFolderWorkspaces'>
): (FolderWorkspace & { multiRepo: MultiRepoWorkspace })[] {
  const result: (FolderWorkspace & { multiRepo: MultiRepoWorkspace })[] = []
  for (const workspace of store.getFolderWorkspaces?.() ?? []) {
    if (workspace.multiRepo) {
      result.push({ ...workspace, multiRepo: workspace.multiRepo })
    }
  }
  return result
}

export function requireMultiRepoWorkspace(
  store: Pick<RuntimeStore, 'getFolderWorkspaces'>,
  folderWorkspaceId: string
): FolderWorkspace & { multiRepo: MultiRepoWorkspace } {
  const workspace = (store.getFolderWorkspaces?.() ?? []).find(
    (entry) => entry.id === folderWorkspaceId
  )
  if (!workspace?.multiRepo) {
    throw new MultiRepoWorkspaceError(
      'multi_repo_workspace_not_found',
      'Multi-repo workspace was not found.'
    )
  }
  return { ...workspace, multiRepo: workspace.multiRepo }
}

export function requireMultiRepoMember(
  multiRepo: MultiRepoWorkspace,
  memberId: string
): MultiRepoMember {
  const member = multiRepo.members.find((entry) => entry.memberId === memberId)
  if (!member) {
    throw new MultiRepoWorkspaceError(
      'multi_repo_member_not_found',
      'Workspace member was not found.'
    )
  }
  return member
}

/** Applies the change to the freshest persisted record; returns null when the workspace is gone. */
export function writeMultiRepoRecord(
  store: MultiRepoRecordStore,
  folderWorkspaceId: string,
  change: (current: MultiRepoWorkspace) => MultiRepoWorkspace
): FolderWorkspace | null {
  const current = (store.getFolderWorkspaces?.() ?? []).find(
    (entry) => entry.id === folderWorkspaceId
  )?.multiRepo
  if (!current) {
    return null
  }
  return store.updateFolderWorkspace?.(folderWorkspaceId, { multiRepo: change(current) }) ?? null
}

export function patchMultiRepoMember(
  store: MultiRepoRecordStore,
  folderWorkspaceId: string,
  memberId: string,
  patch: (member: MultiRepoMember) => MultiRepoMember
): FolderWorkspace | null {
  return writeMultiRepoRecord(store, folderWorkspaceId, (current) => ({
    ...current,
    members: current.members.map((member) =>
      member.memberId === memberId ? patch(member) : member
    )
  }))
}
