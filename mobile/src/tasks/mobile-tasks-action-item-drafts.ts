import type { Dispatch, SetStateAction } from './mobile-tasks-dependencies'
import type { ActionableTaskItem } from './mobile-tasks-project-workspace-types'

export type ActionItemDraftResetters = {
  updateTitle: Dispatch<SetStateAction<string>>
  updateBody: Dispatch<SetStateAction<string>>
  updateComment: Dispatch<SetStateAction<string>>
  updateAddLabels: Dispatch<SetStateAction<string>>
  updateRemoveLabels: Dispatch<SetStateAction<string>>
  updateAddAssignees: Dispatch<SetStateAction<string>>
  updateRemoveAssignees: Dispatch<SetStateAction<string>>
  updateReviewers: Dispatch<SetStateAction<string>>
  updateReplies: Dispatch<SetStateAction<Record<string, string>>>
  updateExpandedFile: Dispatch<SetStateAction<string | null>>
  updateFileComments: Dispatch<SetStateAction<Record<string, string>>>
  updateResolvedGroups: Dispatch<SetStateAction<Set<string>>>
  clearFileContents: () => void
}

export function resetActionItemDrafts(
  item: ActionableTaskItem | null,
  resetters: ActionItemDraftResetters
) {
  resetters.updateTitle(item?.title ?? '')
  resetters.updateBody('')
  resetters.updateComment('')
  resetters.updateAddLabels('')
  resetters.updateRemoveLabels('')
  resetters.updateAddAssignees('')
  resetters.updateRemoveAssignees('')
  resetters.updateReviewers('')
  resetters.updateReplies({})
  resetters.updateExpandedFile(null)
  resetters.clearFileContents()
  resetters.updateFileComments({})
  resetters.updateResolvedGroups(new Set())
}
