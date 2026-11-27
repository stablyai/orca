import type { ReactNode } from 'react'
import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import {
  getProviderChecksOutcome,
  summarizeProviderChecks
} from '../../../../src/shared/source-control/checks/provider-check-summary'
import { Text, View } from 'react-native'
import { CircleCheck, FolderKanban, Gauge, ListChecks, Tag, Users } from 'lucide-react-native'
import { colors, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { Translate } from '../../i18n/mobile-i18n'
import { styles as legacyStyles } from '../mobile-tasks-legacy-styles'
import { discussionSummary } from './mobile-tasks-item-comments'
import {
  renderMobileTasksItemBodyEditor,
  renderMobileTasksItemReviewPanel,
  renderMobileTasksItemFiles
} from './mobile-tasks-item-review-sections'
import { renderMobileTasksItemFieldEditors } from './mobile-tasks-item-field-editors'
import {
  LIST_LEADING_INSET,
  ListGroup,
  ListRow,
  SectionHeader
} from '../../components/list/ListGroup'
import { MobileLoadErrorState, MobileStateView } from '../../components/feedback/MobileStateView'
import type { DetailPayload, GitHubDetailCheck } from '../mobile-tasks-provider-detail-types'

export type MobileTasksDetailSubpage = 'checks' | 'subIssues'

/** What a PR's checks say in one word, from the shared summary the list row's tone also reads. */
function checksValue(
  checks: readonly GitHubDetailCheck[],
  t: Translate
): { text: string; color?: string } {
  const summary = summarizeProviderChecks(checks)
  switch (getProviderChecksOutcome(summary)) {
    case 'failure':
      return {
        text: t('tasks.itemDetailContent.checksFailing', '{{count}} failing', {
          count: summary.failed - (summary.cancelled ?? 0)
        }),
        color: colors.statusRed
      }
    case 'pending':
      return {
        text: t('tasks.itemDetailContent.checksPending', '{{count}} pending', {
          count: summary.pending
        })
      }
    case 'cancelled':
      return { text: t('tasks.itemDetailContent.checksCancelled', 'Cancelled') }
    case 'success':
      return {
        text: t('tasks.itemDetailContent.checksPassed', 'All passed'),
        color: colors.statusGreen
      }
    case 'neutral':
    case 'none':
      return { text: t('tasks.itemDetailContent.checksUnresolved', 'Unresolved') }
  }
}

type FactRow = {
  key: string
  icon: ReactNode
  title: string
  value: string
  valueColor?: string
  onPress?: () => void
}

function factRows(
  payload: DetailPayload,
  isPullRequest: boolean,
  openSubpage: (page: MobileTasksDetailSubpage) => void,
  t: Translate
): FactRow[] {
  const icon = (Icon: typeof Users) => (
    <Icon size={18} color={colors.textSecondary} strokeWidth={2} />
  )
  const rows: FactRow[] = []
  const assignees =
    payload.provider === 'github' || payload.provider === 'gitlab'
      ? payload.assignees
      : payload.assignee
        ? [payload.assignee]
        : []
  if (assignees.length > 0) {
    rows.push({
      key: 'assignees',
      icon: icon(Users),
      title: t('tasks.itemDetailContent.assignees', 'Assignees'),
      value: assignees.join(', ')
    })
  }
  if (payload.labels.length > 0) {
    rows.push({
      key: 'labels',
      icon: icon(Tag),
      title: t('tasks.itemDetailContent.labels', 'Labels'),
      value: payload.labels.join(', ')
    })
  }
  if (payload.provider === 'jira' && payload.priorityName) {
    rows.push({
      key: 'priority',
      icon: icon(Gauge),
      title: t('tasks.itemDetailContent.priority', 'Priority'),
      value: payload.priorityName
    })
  }
  const project =
    payload.provider === 'linear'
      ? payload.project?.name
      : payload.provider === 'jira'
        ? payload.projectName
        : undefined
  if (project) {
    rows.push({
      key: 'project',
      icon: icon(FolderKanban),
      title: t('tasks.itemDetailContent.project', 'Project'),
      value: project
    })
  }
  if (payload.provider === 'github' && isPullRequest && payload.checks.length > 0) {
    const checks = checksValue(payload.checks, t)
    rows.push({
      key: 'checks',
      icon: icon(CircleCheck),
      title: t('tasks.itemDetailContent.checks', 'Checks'),
      value: checks.text,
      valueColor: checks.color,
      onPress: () => openSubpage('checks')
    })
  }
  if (payload.provider === 'linear' && payload.children.length > 0) {
    rows.push({
      key: 'subIssues',
      icon: icon(ListChecks),
      title: t('tasks.itemDetailContent.subIssues', 'Sub-issues'),
      value: String(payload.children.length),
      onPress: () => openSubpage('subIssues')
    })
  }
  return rows
}

/** The facts as one grouped list, then the description and the discussion. */
export function MobileTasksItemDetailContent({
  model,
  openSubpage
}: {
  model: ConnectionPresentationModel
  openSubpage: (page: MobileTasksDetailSubpage) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const {
    actionItem,
    addHostedItemComment,
    addLinearComment,
    commentSendNotice,
    detailCommentGroups,
    detailError,
    detailLoading,
    detailPayload,
    itemCommentDraft,
    linearCommentDraft,
    mutatingStatus,
    renderCommentComposer,
    renderDetailCommentGroup,
    setDetailRefreshSeq,
    setItemCommentDraft,
    setLinearCommentDraft
  } = model
  if (!actionItem) {
    return null
  }
  if (detailLoading) {
    return (
      <MobileStateView loading title={t('tasks.itemDetailContent.loading', 'Loading details…')} />
    )
  }
  if (detailError) {
    return (
      <MobileLoadErrorState
        error={detailError}
        onRetry={() => setDetailRefreshSeq((current) => current + 1)}
      />
    )
  }
  if (!detailPayload) {
    return null
  }
  const isPullRequest =
    (actionItem.provider === 'github' && actionItem.source.type === 'pr') ||
    (actionItem.provider === 'gitlab' && actionItem.source.type === 'mr')
  const facts = factRows(detailPayload, isPullRequest, openSubpage, t)
  return (
    <>
      {facts.length > 0 ? (
        <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
          {facts.map((row) => (
            <ListRow
              key={row.key}
              leading={row.icon}
              title={row.title}
              value={row.value}
              valueColor={row.valueColor}
              navigates={row.onPress !== undefined}
              onPress={row.onPress}
            />
          ))}
        </ListGroup>
      ) : null}

      <SectionHeader title={t('tasks.itemDetailContent.description', 'Description')} />
      <View style={styles.body}>{renderMobileTasksItemBodyEditor(model)}</View>

      {renderMobileTasksItemFieldEditors(model)}
      {renderMobileTasksItemReviewPanel(model)}
      {renderMobileTasksItemFiles(model)}

      <SectionHeader
        title={t('tasks.itemDetailContent.discussion', 'Discussion')}
        trailing={
          detailPayload.comments.length > 0 ? String(detailPayload.comments.length) : undefined
        }
      />
      <View style={styles.body}>
        {detailPayload.comments.length === 0 ? (
          <Text style={legacyStyles.detailMuted}>
            {discussionSummary(detailPayload.comments.length)}
          </Text>
        ) : (
          detailCommentGroups.map(renderDetailCommentGroup)
        )}
        {commentSendNotice ? (
          <Text style={legacyStyles.detailError}>{commentSendNotice.text}</Text>
        ) : null}
        {(detailPayload.provider === 'github' && actionItem.provider === 'github') ||
        (detailPayload.provider === 'gitlab' && actionItem.provider === 'gitlab')
          ? renderCommentComposer({
              value: itemCommentDraft,
              onChangeText: setItemCommentDraft,
              disabled: mutatingStatus,
              onSubmit: () => void addHostedItemComment(actionItem)
            })
          : null}
        {detailPayload.provider === 'linear' && actionItem.provider === 'linear'
          ? renderCommentComposer({
              value: linearCommentDraft,
              onChangeText: setLinearCommentDraft,
              disabled: mutatingStatus,
              onSubmit: () => void addLinearComment(actionItem)
            })
          : null}
      </View>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  group: { backgroundColor: colors.bgPanel, marginTop: spacing.lg },
  body: { paddingHorizontal: spacing.lg, gap: spacing.sm }
}))
