import type {
  MultiRepoDeleteInspectionReply,
  MultiRepoDeleteResultReply
} from './multi-repo-workspace-reply-schema'
import { translate } from '../i18n/mobile-i18n'

export type MultiRepoDeleteRowStatus = { text: string; risky: boolean }

type InspectedMember = MultiRepoDeleteInspectionReply['members'][number]

export function multiRepoDeleteRowStatus(member: InspectedMember): MultiRepoDeleteRowStatus {
  if (!member.worktreeExists) {
    return {
      text: translate(
        'worktree.multiRepoDeleteSheetModel.nothingOnDisk',
        'Nothing on disk to remove'
      ),
      risky: false
    }
  }
  if (member.dirtyCount === null) {
    return {
      text: translate(
        'worktree.multiRepoDeleteSheetModel.dirtyUnknown',
        'Could not check for uncommitted changes'
      ),
      risky: true
    }
  }
  if (member.dirtyCount > 0) {
    return {
      text: translate(
        'worktree.multiRepoDeleteSheetModel.uncommittedFiles_other',
        '{{count}} uncommitted files',
        {
          count: member.dirtyCount
        }
      ),
      risky: true
    }
  }
  if (member.unpublishedCommitCount === null) {
    return {
      text: translate(
        'worktree.multiRepoDeleteSheetModel.unpublishedUnknown',
        'Could not check unpublished commits'
      ),
      risky: false
    }
  }
  if (member.unpublishedCommitCount > 0) {
    return {
      text: translate(
        'worktree.multiRepoDeleteSheetModel.unpublishedCommits_other',
        '{{count}} unpublished commits',
        {
          count: member.unpublishedCommitCount
        }
      ),
      risky: false
    }
  }
  return {
    text: translate('worktree.multiRepoDeleteSheetModel.clean', 'No uncommitted changes'),
    risky: false
  }
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
        ? translate(
            'worktree.multiRepoDeleteSheetModel.removedBranchKept',
            'Removed. Branch {{branch}} kept: unmerged commits',
            {
              branch: outcome.preservedBranch
            }
          )
        : translate('worktree.multiRepoDeleteSheetModel.removed', 'Removed')
    case 'dropped':
      return translate('worktree.multiRepoDeleteSheetModel.dropped', 'Removed from workspace')
    case 'failed':
      return translate('worktree.multiRepoDeleteSheetModel.failed', 'Failed: {{message}}', {
        message: outcome.message
      })
  }
}

export function multiRepoRootKeptText(
  rootKept: NonNullable<MultiRepoDeleteResultReply['rootKept']>
): string {
  switch (rootKept.reason) {
    case 'not_empty':
      return translate(
        'worktree.multiRepoDeleteSheetModel.folderKeptNotEmpty',
        'Folder kept: it contains files ({{path}})',
        {
          path: rootKept.path
        }
      )
    case 'not_owned':
      return translate(
        'worktree.multiRepoDeleteSheetModel.folderKeptNotOwned',
        'Folder kept: Orca did not create it ({{path}})',
        { path: rootKept.path }
      )
    case 'remove_failed':
      return translate(
        'worktree.multiRepoDeleteSheetModel.folderKeptFailed',
        'Folder kept: it could not be removed ({{path}})',
        { path: rootKept.path }
      )
  }
}
