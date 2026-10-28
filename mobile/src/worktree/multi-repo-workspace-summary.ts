import type { FolderWorkspace } from '../../../src/shared/folder-workspace-types'
import type {
  MultiRepoMember,
  MultiRepoMemberState
} from '../../../src/shared/multi-repo-workspace'
import type { Worktree } from './workspace-list-types'

export type MobileMultiRepoMember = Pick<
  MultiRepoMember,
  'memberId' | 'repoId' | 'dirName' | 'branchName' | 'state' | 'worktreeId'
> & { failureMessage?: string }

export type MobileMultiRepoSummary = {
  folderWorkspaceId: string
  members: MobileMultiRepoMember[]
}

export function summarizeMultiRepoWorkspace(
  folderWorkspace: Pick<FolderWorkspace, 'id' | 'multiRepo'>
): MobileMultiRepoSummary | undefined {
  if (!folderWorkspace.multiRepo) {
    return undefined
  }
  return {
    folderWorkspaceId: folderWorkspace.id,
    members: folderWorkspace.multiRepo.members.map((member) => ({
      memberId: member.memberId,
      repoId: member.repoId,
      dirName: member.dirName,
      branchName: member.branchName,
      state: member.state,
      ...(member.worktreeId ? { worktreeId: member.worktreeId } : {}),
      ...(member.failure ? { failureMessage: member.failure.message } : {})
    }))
  }
}

export function multiRepoChipText(
  members: readonly Pick<MobileMultiRepoMember, 'state'>[]
): string {
  const count = (state: MultiRepoMemberState): number =>
    members.filter((member) => member.state === state).length
  const pending = count('queued') + count('creating')
  if (pending > 0) {
    return `Creating ${count('ready')}/${members.length}`
  }
  const parts = [members.length === 1 ? '1 repo' : `${members.length} repos`]
  if (count('failed') > 0) {
    parts.push(`${count('failed')} failed`)
  }
  if (count('interrupted') > 0) {
    parts.push(`${count('interrupted')} interrupted`)
  }
  return parts.join(' · ')
}

export function multiRepoMemberStateLabel(state: MultiRepoMemberState): string {
  switch (state) {
    case 'queued':
      return 'Waiting'
    case 'creating':
      return 'Creating'
    case 'ready':
      return 'Ready'
    case 'failed':
      return 'Failed'
    case 'interrupted':
      return 'Interrupted'
  }
}

export function isMultiRepoMemberRetryable(member: Pick<MobileMultiRepoMember, 'state'>): boolean {
  return member.state === 'failed' || member.state === 'interrupted'
}

export function multiRepoMemberOpenTarget(
  parent: Worktree,
  member: MobileMultiRepoMember
): Worktree | null {
  if (member.state !== 'ready' || !member.worktreeId) {
    return null
  }
  return {
    ...parent,
    worktreeId: member.worktreeId,
    repoId: member.repoId,
    workspaceKind: 'git',
    displayName: member.dirName,
    repo: member.dirName,
    branch: member.branchName,
    multiRepo: undefined
  }
}

export function multiRepoRowNeedsAttention(summary: MobileMultiRepoSummary): boolean {
  return summary.members.some((member) => member.state !== 'ready')
}
