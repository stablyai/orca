import type {
  MultiRepoDeleteInspectionReply,
  MultiRepoDeleteResultReply
} from './multi-repo-workspace-reply-schema'

export type MultiRepoDeleteRowStatus = { text: string; risky: boolean }

type InspectedMember = MultiRepoDeleteInspectionReply['members'][number]

export function multiRepoDeleteRowStatus(member: InspectedMember): MultiRepoDeleteRowStatus {
  if (!member.worktreeExists) {
    return { text: 'Nothing on disk to remove', risky: false }
  }
  if (member.dirtyCount === null) {
    return { text: 'Could not check for uncommitted changes', risky: true }
  }
  if (member.dirtyCount > 0) {
    return {
      text: `${member.dirtyCount} uncommitted ${member.dirtyCount === 1 ? 'file' : 'files'}`,
      risky: true
    }
  }
  if (member.unpublishedCommitCount === null) {
    return { text: 'Could not check unpublished commits', risky: false }
  }
  if (member.unpublishedCommitCount > 0) {
    return {
      text: `${member.unpublishedCommitCount} unpublished ${member.unpublishedCommitCount === 1 ? 'commit' : 'commits'}`,
      risky: false
    }
  }
  return { text: 'No uncommitted changes', risky: false }
}

/** The phone never discards work: an unknown or non-zero dirty count blocks the delete. */
export function multiRepoDeleteBlockedByChanges(members: readonly InspectedMember[]): boolean {
  return members.some((member) => member.worktreeExists && member.dirtyCount !== 0)
}

export function multiRepoDeleteOutcomeText(
  outcome: MultiRepoDeleteResultReply['members'][number]
): string {
  switch (outcome.status) {
    case 'removed':
      return outcome.preservedBranch
        ? `Removed. Branch ${outcome.preservedBranch} kept: unmerged commits`
        : 'Removed'
    case 'dropped':
      return 'Removed from workspace'
    case 'failed':
      return `Failed: ${outcome.message}`
  }
}

export function multiRepoRootKeptText(
  rootKept: NonNullable<MultiRepoDeleteResultReply['rootKept']>
): string {
  switch (rootKept.reason) {
    case 'not_empty':
      return `Folder kept: it contains files (${rootKept.path})`
    case 'not_owned':
      return `Folder kept: Orca did not create it (${rootKept.path})`
    case 'remove_failed':
      return `Folder kept: it could not be removed (${rootKept.path})`
  }
}
