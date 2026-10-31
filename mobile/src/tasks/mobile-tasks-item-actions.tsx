import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import { translate } from '../i18n/mobile-i18n'
import {
  View,
  Pressable,
  Plus,
  colors,
  Text,
  Linking,
  ExternalLink,
  Check,
  Copy,
  RefreshCw,
  X,
  GitBranch,
  MoreHorizontal
} from './mobile-tasks-dependencies'
import { styles } from './mobile-tasks-legacy-styles'
import {
  taskExternalOpenLabel,
  taskStatusActionLabel,
  isGitHubPrMergeBlocked
} from './mobile-tasks-legacy-foundation'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { NavBarButton } from '../components/nav-bar/NavBarButton'

/** The detail sheet's status and merge actions, which live behind its "…" button. */
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

function copyLinkLabel(provider: string): string {
  if (provider === 'github') {
    return translate('tasks.itemActions.copyGitHubLink', 'Copy GitHub link')
  }
  if (provider === 'linear') {
    return translate('tasks.itemActions.copyLinearLink', 'Copy Linear link')
  }
  return translate('tasks.itemActions.copyLink', 'Copy link')
}

/** Start workspace, then Open, Copy and "…" as round buttons beside it. */
export function renderMobileTasksItemActions(
  model: ConnectionPresentationModel,
  onOpenMenu: () => void
) {
  const {
    actionItem,
    taskDetailHandoff,
    copiedLinkKey,
    copyTaskLink,
    copyTextToClipboard,
    creatingKey,
    openWorkspaceCreate,
    setWorkspaceRepoPickerItem,
    workspaceRepos
  } = model
  if (!actionItem) {
    return null
  }
  const creating = creatingKey === actionItem.key
  // GitHub keeps its own copy path; the rest copy the same URL through the plain clipboard.
  const copyKey =
    actionItem.provider === 'github'
      ? `task:${actionItem.key}`
      : `${actionItem.provider}-url:${actionItem.key}`
  const copied = copiedLinkKey === copyKey
  return (
    <View style={styles.itemActionBar}>
      <Pressable
        style={({ pressed }) => [
          styles.itemStartButton,
          pressed && styles.itemStartButtonPressed,
          creating && styles.itemStartButtonBusy
        ]}
        disabled={creating}
        accessibilityRole="button"
        accessibilityState={{ disabled: creating, busy: creating }}
        testID="mobile-tasks-start-workspace"
        onPress={() =>
          taskDetailHandoff.closeThen(() => {
            // Jira and Linear are not repo-scoped; ask for the target repo instead of choosing the first.
            const needsRepoChoice =
              actionItem.provider === 'linear' || actionItem.provider === 'jira'
            if (needsRepoChoice && workspaceRepos.length > 1) {
              setWorkspaceRepoPickerItem(actionItem)
              return
            }
            openWorkspaceCreate(actionItem)
          })
        }
      >
        <Plus size={16} color={colors.bgBase} strokeWidth={2.4} />
        <Text style={styles.itemStartText} numberOfLines={1}>
          {creating
            ? translate('tasks.itemActions.creating', 'Creating...')
            : translate('tasks.itemActions.startWorkspace', 'Start workspace')}
        </Text>
      </Pressable>
      <NavBarButton
        icon={ExternalLink}
        accessibilityLabel={taskExternalOpenLabel(actionItem)}
        onPress={() => Linking.openURL(actionItem.source.url)}
      />
      <NavBarButton
        icon={copied ? Check : Copy}
        accessibilityLabel={
          copied ? translate('common.copied', 'Copied') : copyLinkLabel(actionItem.provider)
        }
        onPress={() =>
          actionItem.provider === 'github'
            ? void copyTaskLink(copyKey, actionItem.source.url)
            : void copyTextToClipboard(copyKey, actionItem.source.url)
        }
      />
      {mobileTasksItemMenuActions(model).length > 0 ? (
        <NavBarButton
          icon={MoreHorizontal}
          accessibilityLabel={translate('tasks.itemActions.moreActions', 'More actions')}
          onPress={onOpenMenu}
        />
      ) : null}
    </View>
  )
}
