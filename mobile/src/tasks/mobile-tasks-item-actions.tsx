import type { ConnectionPresentationModel } from './use-mobile-tasks-connection-presentation'
import type { PageChromeModel } from './use-mobile-tasks-page-chrome'
import {
  View,
  StyleSheet,
  Plus,
  Linking,
  ExternalLink,
  Check,
  Copy,
  RefreshCw,
  X,
  Ellipsis,
  GitMerge,
  CircleDot,
  spacing
} from './mobile-tasks-dependencies'
import {
  taskExternalOpenLabel,
  taskStatusActionLabel,
  isGitHubPrMergeBlocked,
  projectRowType
} from './mobile-tasks-legacy-foundation'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import { Button } from '../components/ui/Button'
import { IconButton } from '../components/ui/IconButton'
import { MobileTasksSheetFootnote } from './mobile-tasks-sheet-chrome'

/** The detail sheet's Close, Merge and Status actions, which live behind its "…" button. */
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
  if (actionItem.provider === 'linear') {
    actions.push({
      label: 'Change status',
      icon: CircleDot,
      disabled: mutatingStatus,
      onPress: () => setLinearStatusPickerItem(actionItem)
    })
  }
  if (
    actionItem.provider === 'github' &&
    actionItem.source.type === 'pr' &&
    actionItem.source.state === 'open'
  ) {
    const blocked = isGitHubPrMergeBlocked(actionItem)
    actions.push({
      label: 'Merge pull request',
      icon: GitMerge,
      disabled: mutatingStatus || blocked,
      hint: blocked ? 'GitHub reports merge conflicts.' : undefined,
      onPress: () => setMergeMethodTaskItem(actionItem)
    })
  }
  if (
    actionItem.provider === 'gitlab' &&
    actionItem.source.type === 'mr' &&
    actionItem.source.state === 'opened'
  ) {
    actions.push({
      label: 'Merge merge request',
      icon: GitMerge,
      disabled: mutatingStatus,
      onPress: () => setMergeMethodTaskItem(actionItem)
    })
  }
  if (actionItem.provider === 'github' && actionItem.source.state !== 'merged') {
    const closing = actionItem.source.state !== 'closed'
    actions.push({
      label: taskStatusActionLabel(actionItem),
      icon: closing ? X : RefreshCw,
      destructive: closing,
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
    actionItem.provider === 'gitlab' &&
    actionItem.source.state !== 'merged' &&
    actionItem.source.state !== 'locked'
  ) {
    const closing = actionItem.source.state !== 'closed'
    actions.push({
      label: taskStatusActionLabel(actionItem),
      icon: closing ? X : RefreshCw,
      destructive: closing,
      disabled: mutatingStatus,
      onPress: () =>
        setPendingHostedStateChange({
          source: 'task',
          item: actionItem,
          nextState: closing ? 'closed' : 'opened'
        })
    })
  }
  return actions
}

/** The same menu for a GitHub Project item. */
export function mobileTasksProjectMenuActions(
  model: ConnectionPresentationModel
): ActionSheetAction[] {
  const {
    projectMutating,
    projectRowHostedRepo,
    projectRowItem,
    setMergeMethodProjectRow,
    setPendingHostedStateChange
  } = model
  if (!projectRowItem) {
    return []
  }
  const actions: ActionSheetAction[] = []
  if (
    projectRowItem.itemType === 'PULL_REQUEST' &&
    projectRowItem.content.state !== 'CLOSED' &&
    projectRowItem.content.state !== 'MERGED'
  ) {
    actions.push({
      label: 'Merge pull request',
      icon: GitMerge,
      disabled: projectMutating || !projectRowHostedRepo,
      hint: projectRowHostedRepo ? undefined : 'Merging needs this repository added to Orca.',
      onPress: () => setMergeMethodProjectRow(projectRowItem)
    })
  }
  if (
    projectRowType(projectRowItem) &&
    projectRowItem.content.state !== 'MERGED' &&
    projectRowItem.itemType !== 'DRAFT_ISSUE'
  ) {
    const closing = projectRowItem.content.state !== 'CLOSED'
    actions.push({
      label: closing ? 'Close item' : 'Reopen item',
      icon: closing ? X : RefreshCw,
      destructive: closing,
      disabled: projectMutating,
      onPress: () =>
        setPendingHostedStateChange({
          source: 'project',
          row: projectRowItem,
          nextState: closing ? 'closed' : 'open'
        })
    })
  }
  return actions
}

type DetailActionBarProps = {
  startLabel: string
  starting: boolean
  /** Null when this item can't start a workspace; the reason shows instead of the button. */
  onStart: (() => void) | null
  startUnavailableReason?: string
  url: string | null
  openLabel: string
  copied: boolean
  onCopy: (() => void) | null
  menuCount: number
  onMenu: () => void
}

/** The one primary action right under the header, with Open, Copy and "…" beside it. */
export function MobileTasksDetailActionBar(props: DetailActionBarProps) {
  const { url } = props
  return (
    <View style={actionStyles.wrap}>
      <View style={actionStyles.bar}>
        {props.onStart ? (
          <Button
            label={props.startLabel}
            icon={Plus}
            variant="primary"
            block
            busy={props.starting}
            onPress={props.onStart}
            style={actionStyles.primary}
            testID="mobile-tasks-start-workspace"
          />
        ) : (
          <View style={actionStyles.primary} />
        )}
        {url ? (
          <IconButton
            icon={ExternalLink}
            iconSize={18}
            accessibilityLabel={props.openLabel}
            onPress={() => Linking.openURL(url)}
          />
        ) : null}
        {props.onCopy ? (
          <IconButton
            icon={props.copied ? Check : Copy}
            iconSize={18}
            accessibilityLabel={props.copied ? 'Link copied' : 'Copy link'}
            onPress={props.onCopy}
          />
        ) : null}
        {props.menuCount > 0 ? (
          <IconButton
            icon={Ellipsis}
            iconSize={18}
            accessibilityLabel="More actions"
            onPress={props.onMenu}
          />
        ) : null}
      </View>
      {props.startUnavailableReason ? (
        <MobileTasksSheetFootnote>{props.startUnavailableReason}</MobileTasksSheetFootnote>
      ) : null}
    </View>
  )
}

export function renderMobileTasksItemActions(model: PageChromeModel) {
  const {
    actionItem,
    taskDetailHandoff,
    copiedLinkKey,
    copyTaskLink,
    copyTextToClipboard,
    creatingKey,
    openWorkspaceCreate,
    setDetailMenu,
    setWorkspaceRepoPickerItem,
    workspaceRepos
  } = model
  if (!actionItem) {
    return null
  }
  // GitHub keeps its own copy path; the rest copy the same URL through the plain clipboard.
  const copyKey =
    actionItem.provider === 'github'
      ? `task:${actionItem.key}`
      : `${actionItem.provider}-url:${actionItem.key}`
  return (
    <MobileTasksDetailActionBar
      startLabel="Start workspace"
      starting={creatingKey === actionItem.key}
      onStart={() =>
        taskDetailHandoff.closeThen(() => {
          // Jira, like Linear, is not repo-scoped, so the target repo has to be asked for
          // rather than defaulted to the first one.
          const needsRepoChoice = actionItem.provider === 'linear' || actionItem.provider === 'jira'
          if (needsRepoChoice && workspaceRepos.length > 1) {
            setWorkspaceRepoPickerItem(actionItem)
            return
          }
          openWorkspaceCreate(actionItem)
        })
      }
      url={actionItem.source.url}
      openLabel={taskExternalOpenLabel(actionItem)}
      copied={copiedLinkKey === copyKey}
      onCopy={() =>
        actionItem.provider === 'github'
          ? void copyTaskLink(copyKey, actionItem.source.url)
          : void copyTextToClipboard(copyKey, actionItem.source.url)
      }
      menuCount={mobileTasksItemMenuActions(model).length}
      onMenu={() => setDetailMenu('item')}
    />
  )
}

const actionStyles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  primary: { flex: 1, marginRight: spacing.xs }
})
