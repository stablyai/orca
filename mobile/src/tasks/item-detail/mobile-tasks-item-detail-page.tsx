import { useEffect, useRef, useState } from 'react'
import type { ScrollViewInstance } from 'react-native'
import { ScrollView, Text, View } from 'react-native'
import {
  ChevronLeft,
  Copy,
  Ellipsis,
  ExternalLink,
  GitBranch,
  RefreshCw,
  Circle,
  CircleCheck,
  CircleMinus,
  CircleX
} from 'lucide-react-native'
import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import type { ActionableTaskItem } from '../mobile-tasks-project-workspace-types'
import type { GitHubDetailCheck } from '../mobile-tasks-provider-detail-types'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { NavBar } from '../../components/nav-bar/NavBar'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../../components/nav-bar/PullDownMenu'
import { SheetPrimaryButton } from '../../components/sheets/SheetPrimaryButton'
import { TransientToast } from '../../components/feedback/TransientToast'
import { describeLoadError } from '../../components/feedback/load-error-description'
import { useKeyboardOcclusion } from '../../platform/keyboard/keyboard-occlusion'
import { styles as legacyStyles } from '../mobile-tasks-legacy-styles'
import { OptionPager, useOptionPager } from '../../components/bottom-drawer/BottomDrawer'
import { ListGroup, ListRow, LIST_LEADING_INSET } from '../../components/list/ListGroup'
import { useBackClaim } from '../../navigation/use-back-claim'
import { openExternalLink } from '../../platform/external-links/external-link'
import { classifyCheckOutcome } from '../../../../src/shared/source-control/checks/provider-check-summary'
import { formatUpdatedAt } from './mobile-tasks-item-mapping'
import { taskExternalOpenLabel } from './mobile-tasks-item-comments'
import { taskItemStateGlyph } from './mobile-tasks-item-state-glyph'
import { mobileTasksItemMenuActions } from './mobile-tasks-item-actions'
import {
  MobileTasksItemDetailContent,
  type MobileTasksDetailSubpage
} from './mobile-tasks-item-detail-content'

// SheetPrimaryButton's height, for the toast to clear the Start workspace bar.
const BAR_BUTTON_HEIGHT = 48

function navTitle(item: ActionableTaskItem): string {
  switch (item.provider) {
    case 'github':
      return `#${item.source.number}`
    case 'gitlab':
      return `${item.source.type === 'mr' ? '!' : '#'}${item.source.number}`
    case 'linear':
      return item.source.identifier
    case 'jira':
      return item.source.key
  }
}

function navSubtitle(item: ActionableTaskItem): string {
  return item.provider === 'github' || item.provider === 'gitlab'
    ? item.source.repoName
    : item.subtitle
}

function authorOf(item: ActionableTaskItem): string | null {
  return item.provider === 'github' || item.provider === 'gitlab' ? item.source.author : null
}

/** One issue or PR as a page pushed over the list: facts, description, discussion, and Start workspace at the foot. */
export function MobileTasksItemDetailPage({
  model,
  item,
  onBack
}: {
  model: ConnectionPresentationModel
  item: ActionableTaskItem
  onBack: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const pager = useOptionPager<MobileTasksDetailSubpage>()
  const keyboard = useKeyboardOcclusion()
  const scroll = useRef<ScrollViewInstance | null>(null)
  // The comment box is the page's only field and sits last, so a rising keyboard scrolls to it.
  useEffect(() => {
    if (keyboard > 0) {
      scroll.current?.scrollToEnd({ animated: true })
    }
  }, [keyboard])
  const copyKey = mobileTaskCopyKey(item)
  // Back closes an open checks or sub-issues list before it leaves the item.
  useBackClaim(() => {
    if (pager.page) {
      pager.close()
    } else {
      onBack()
    }
    return true
  })
  const main = (
    <View style={styles.fill}>
      <DetailNavBar model={model} item={item} copyKey={copyKey} onBack={onBack} />
      <PageError model={model} />
      <ScrollView
        ref={scroll}
        style={[styles.fill, keyboard > 0 && { marginBottom: keyboard }]}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <DetailHeading item={item} />
        <MobileTasksItemDetailContent model={model} openSubpage={pager.open} />
      </ScrollView>
      {keyboard > 0 ? null : <StartWorkspaceBar model={model} item={item} />}
      <TransientToast
        message={model.copiedLinkKey === copyKey ? t('common.copied', 'Copied') : null}
        bottomInset={
          keyboard > 0
            ? keyboard
            : spacing.sm + BAR_BUTTON_HEIGHT + Math.max(model.insets.bottom, spacing.md)
        }
      />
    </View>
  )
  const page =
    pager.page === null ? null : (
      <View style={styles.fill}>
        <NavBar
          leading={
            <NavBarButton
              icon={ChevronLeft}
              onPress={pager.close}
              accessibilityLabel={t('common.back', 'Back')}
            />
          }
          title={
            pager.page === 'checks'
              ? t('tasks.itemDetailContent.checks', 'Checks')
              : t('tasks.itemDetailContent.subIssues', 'Sub-issues')
          }
          subtitle={navTitle(item)}
        />
        <PageError model={model} />
        <ScrollView style={styles.fill} contentContainerStyle={styles.scroll}>
          {pager.page === 'checks' ? (
            <ChecksList model={model} />
          ) : (
            <SubIssueList model={model} item={item} />
          )}
        </ScrollView>
      </View>
    )
  return (
    // The screen's safe area already pads the top, as it does for the list under this page.
    <OptionPager fill pager={pager} main={main} page={page} />
  )
}

// GitHub keeps its own copy path; the rest copy the same URL through the plain clipboard.
function mobileTaskCopyKey(item: ActionableTaskItem): string {
  return item.provider === 'github' ? `task:${item.key}` : `${item.provider}-url:${item.key}`
}

function DetailNavBar({
  model,
  item,
  copyKey,
  onBack
}: {
  model: ConnectionPresentationModel
  item: ActionableTaskItem
  copyKey: string
  onBack: () => void
}) {
  const t = useMobileTranslation()
  const anchor = useRef(null)
  const [open, setOpen] = useState(false)
  const stateActions = mobileTasksItemMenuActions(model)
  return (
    <>
      <NavBar
        leading={
          <NavBarButton
            icon={ChevronLeft}
            onPress={onBack}
            accessibilityLabel={t('common.back', 'Back')}
          />
        }
        title={navTitle(item)}
        subtitle={navSubtitle(item)}
        trailing={
          <NavBarButton
            ref={anchor}
            icon={Ellipsis}
            accessibilityLabel={t('tasks.itemActions.moreActions', 'More actions')}
            onPress={() => setOpen(true)}
          />
        }
      />
      <PullDownMenu
        visible={open}
        anchorRef={anchor}
        onClose={() => setOpen(false)}
        groups={[
          [
            {
              label: t('tasks.itemActions.copyLink', 'Copy link'),
              icon: Copy,
              onPress: () =>
                item.provider === 'github'
                  ? void model.copyTaskLink(copyKey, item.source.url)
                  : void model.copyTextToClipboard(copyKey, item.source.url)
            },
            {
              label: taskExternalOpenLabel(item),
              icon: ExternalLink,
              onPress: () => void openExternalLink(item.source.url)
            },
            {
              label: t('common.refresh', 'Refresh'),
              icon: RefreshCw,
              disabled: model.detailLoading,
              onPress: model.requestDetailRefresh
            }
          ],
          // These open a confirm or picker sheet, so the menu's own modal must be gone first.
          ...(stateActions.length > 0
            ? [stateActions.map((action) => ({ ...action, closeBeforePress: true }))]
            : [])
        ]}
      />
    </>
  )
}

// The list's banner is under this page; what this page's actions report shows here.
function PageError({ model }: { model: ConnectionPresentationModel }) {
  const t = useMobileTranslation()
  return model.error ? (
    <View style={legacyStyles.errorBanner}>
      <Text style={legacyStyles.errorText}>{describeLoadError(model.error, t).message}</Text>
    </View>
  ) : null
}

function DetailHeading({ item }: { item: ActionableTaskItem }) {
  const glyph = taskItemStateGlyph(item)
  const author = authorOf(item)
  const updated = formatUpdatedAt(item.updatedAt)
  return (
    <View style={styles.heading}>
      <Text style={styles.title} accessibilityRole="header">
        {item.title}
      </Text>
      <View style={styles.meta}>
        <glyph.icon size={14} color={glyph.color} strokeWidth={2.2} />
        <Text style={styles.metaText} numberOfLines={1}>
          <Text style={[styles.stateWord, { color: glyph.color }]}>{item.status}</Text>
          {[author, updated].filter(Boolean).map((part) => ` · ${part}`)}
        </Text>
      </View>
    </View>
  )
}

function StartWorkspaceBar({
  model,
  item
}: {
  model: ConnectionPresentationModel
  item: ActionableTaskItem
}) {
  const t = useMobileTranslation()
  const { creatingKey, insets, openWorkspaceCreate, setWorkspaceRepoPickerItem, workspaceRepos } =
    model
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
      <SheetPrimaryButton
        label={t('tasks.itemActions.startWorkspace', 'Start workspace')}
        icon={GitBranch}
        busy={creatingKey === item.key}
        testID="mobile-tasks-start-workspace"
        onPress={() => {
          // Jira and Linear are not repo-scoped; ask for the target repo instead of choosing the first.
          if (
            (item.provider === 'linear' || item.provider === 'jira') &&
            workspaceRepos.length > 1
          ) {
            setWorkspaceRepoPickerItem(item)
            return
          }
          openWorkspaceCreate(item)
        }}
      />
    </View>
  )
}

// The shared classifier, so an approval-waiting run reads as pending and a startup failure as failed.
function checkLook(check: GitHubDetailCheck, t: Translate) {
  const outcome = classifyCheckOutcome(check)
  if (outcome === 'failed') {
    return {
      Icon: CircleX,
      color: colors.statusRed,
      word: t('tasks.itemDetailPage.checkFailed', 'Failed')
    }
  }
  if (outcome === 'pending') {
    return {
      Icon: Circle,
      color: colors.textMuted,
      word: t('tasks.itemDetailPage.checkPending', 'Pending')
    }
  }
  // Skipped counts as passing for merge, but the row says what happened.
  if (check.conclusion === 'skipped') {
    return {
      Icon: CircleMinus,
      color: colors.textMuted,
      word: t('tasks.itemDetailPage.checkSkipped', 'Skipped')
    }
  }
  return outcome === 'passed'
    ? {
        Icon: CircleCheck,
        color: colors.statusGreen,
        word: t('tasks.itemDetailPage.checkPassed', 'Passed')
      }
    : {
        Icon: CircleMinus,
        color: colors.textMuted,
        word: t('tasks.itemDetailPage.checkNeutral', 'Neutral')
      }
}

function ChecksList({ model }: { model: ConnectionPresentationModel }) {
  const t = useMobileTranslation()
  const payload = model.detailPayload
  if (payload?.provider !== 'github') {
    return null
  }
  return (
    <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
      {payload.checks.map((check) => {
        const { Icon, color, word } = checkLook(check, t)
        const url = check.url
        return (
          <ListRow
            key={`${check.name}:${check.status}:${url ?? ''}`}
            leading={<Icon size={18} strokeWidth={2} color={color} />}
            title={check.name}
            value={word}
            onPress={url ? () => void openExternalLink(url) : undefined}
          />
        )
      })}
    </ListGroup>
  )
}

function SubIssueList({
  model,
  item
}: {
  model: ConnectionPresentationModel
  item: ActionableTaskItem
}) {
  const payload = model.detailPayload
  if (payload?.provider !== 'linear' || item.provider !== 'linear') {
    return null
  }
  return (
    <ListGroup style={styles.group}>
      {payload.children.map((child) => (
        <ListRow
          key={child.id}
          titlePrefix={child.identifier}
          title={child.title}
          navigates
          disabled={model.mutatingStatus}
          onPress={() => void model.openLinearSubIssue(child, item.key, item.source.workspaceId)}
        />
      ))}
    </ListGroup>
  )
}

const styles = themedStyleSheet(() => ({
  fill: { flex: 1, backgroundColor: colors.bgBase },
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  heading: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: 6 },
  title: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '700',
    letterSpacing: -0.2,
    color: colors.textPrimary
  },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  metaText: { flexShrink: 1, fontSize: 13, color: colors.textSecondary },
  stateWord: { fontWeight: '600' },
  group: { backgroundColor: colors.bgPanel, marginTop: spacing.lg },
  bar: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, backgroundColor: colors.bgBase }
}))
