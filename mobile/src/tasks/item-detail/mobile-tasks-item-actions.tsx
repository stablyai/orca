import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import { translate } from '../../i18n/mobile-i18n'
import { RefreshCw, X, GitBranch } from 'lucide-react-native'
import { taskStatusActionLabel, isGitHubPrMergeBlocked } from './mobile-tasks-item-comments'
import type { ActionSheetAction } from '../../components/sheets/ActionSheetModal'

/** The detail page's status and merge actions, in the lower group of its ⋯ menu. */
export function mobileTasksItemMenuActions(
  model: ConnectionPresentationModel
): ActionSheetAction[] {
  const {
    actionItem,
    mutatingStatus,
    setLinearStatusPickerItem,
    setMergeMethodTaskItem,
    setPendingHostedStateChange
  } = model
  if (!actionItem) {
    return []
  }
  const actions: ActionSheetAction[] = []
  if (actionItem.provider === 'github' && actionItem.source.state !== 'merged') {
    const closing = actionItem.source.state !== 'closed'
    actions.push({
      label: taskStatusActionLabel(actionItem),
      icon: closing ? X : RefreshCw,
      disabled: mutatingStatus,
      onPress: () =>
        setPendingHostedStateChange({
          source: 'task',
          item: actionItem,
          nextState: closing ? 'closed' : 'open'
        })
    })
  }
  if (
    actionItem.provider === 'github' &&
    actionItem.source.type === 'pr' &&
    actionItem.source.state === 'open'
  ) {
    const blocked = isGitHubPrMergeBlocked(actionItem)
    actions.push({
      label: translate('tasks.itemActions.mergePullRequest', 'Merge pull request'),
      icon: GitBranch,
      disabled: mutatingStatus || blocked,
      hint: blocked
        ? translate('tasks.itemActions.mergeConflicts', 'GitHub reports merge conflicts.')
        : undefined,
      onPress: () => setMergeMethodTaskItem(actionItem)
    })
  }
  if (
    actionItem.provider === 'gitlab' &&
    actionItem.source.state !== 'merged' &&
    actionItem.source.state !== 'locked'
  ) {
    const closing = actionItem.source.state !== 'closed'
    actions.push({
      label: taskStatusActionLabel(actionItem),
      icon: closing ? X : RefreshCw,
      disabled: mutatingStatus,
      onPress: () =>
        setPendingHostedStateChange({
          source: 'task',
          item: actionItem,
          nextState: closing ? 'closed' : 'opened'
        })
    })
  }
  if (
    actionItem.provider === 'gitlab' &&
    actionItem.source.type === 'mr' &&
    actionItem.source.state === 'opened'
  ) {
    actions.push({
      label: translate('tasks.itemActions.mergeMergeRequest', 'Merge merge request'),
      icon: GitBranch,
      disabled: mutatingStatus,
      onPress: () => setMergeMethodTaskItem(actionItem)
    })
  }
  if (actionItem.provider === 'linear') {
    actions.push({
      label: translate('tasks.itemActions.changeStatus', 'Change status'),
      icon: GitBranch,
      disabled: mutatingStatus,
      onPress: () => setLinearStatusPickerItem(actionItem)
    })
  }
  return actions
}
