import { StyleSheet, View } from 'react-native'
import { ListRow, LIST_LEADING_INSET } from '../../components/list/ListGroup'
import { radii, spacing, type MobilePalette } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { HostedReviewMergeTone } from '../../../../src/shared/github/pull-requests/merge/pull-request-merge-state'
import {
  getGitHubMergeChip,
  getGitLabMergeChip,
  getHostedReviewSignalTone
} from '../hosted-review/mobile-hosted-check-status'
import { formatUpdatedAt } from '../item-detail/mobile-tasks-item-mapping'
import { taskKindLabel } from '../item-detail/mobile-tasks-item-comments'
import { taskItemStateGlyph } from '../item-detail/mobile-tasks-item-state-glyph'
import type { TaskItem } from '../mobile-tasks-project-workspace-types'

function toneColor(tone: HostedReviewMergeTone, colors: MobilePalette): string {
  switch (tone) {
    case 'success':
      return colors.statusGreen
    case 'warning':
      return colors.agentQuestionText
    case 'danger':
      return colors.statusRed
    case 'neutral':
      return colors.textSecondary
  }
}

/** The one word a review row leads with: what blocks it or what's next, in its tone. */
export function taskRowStatus(
  item: TaskItem,
  t: Translate,
  colors: MobilePalette
): { text: string; color: string } | null {
  const review =
    item.provider === 'github' && item.source.type === 'pr'
      ? { source: item.source, chip: getGitHubMergeChip(t, item.source) }
      : item.provider === 'gitlab' && item.source.type === 'mr'
        ? { source: item.source, chip: getGitLabMergeChip(t, item.source) }
        : null
  if (!review) {
    return null
  }
  if (review.source.state === 'draft') {
    return { text: t('tasks.row.draft', 'Draft'), color: colors.textMuted }
  }
  if (review.chip) {
    return { text: review.chip.label, color: toneColor(review.chip.tone, colors) }
  }
  // List reads often carry no merge metadata; checks and the review still say what's next.
  if (getHostedReviewSignalTone(review.source, 'checks') === 'danger') {
    return {
      text: t('auto.components.github.pr.merge.state.87fa36ac83', 'Checks failed'),
      color: colors.statusRed
    }
  }
  return review.source.reviewDecision === 'APPROVED'
    ? { text: t('tasks.row.approved', 'Approved'), color: colors.statusGreen }
    : null
}

// Where the item lives and how fresh it is; the glyph carries kind and state except for Jira and todos.
function taskRowMeta(item: TaskItem): string {
  const lead =
    item.provider === 'gitlabTodo'
      ? `${item.status} · ${item.subtitle}`
      : item.provider === 'jira'
        ? `${item.subtitle} · ${item.status}`
        : item.subtitle
  return [lead, formatUpdatedAt(item.updatedAt)].filter(Boolean).join(' · ')
}

/** One task as a grouped-list row: state glyph, one-line title, "acme-web #482 · 1h". */
export function MobileTaskRow({
  item,
  first,
  last,
  meta = taskRowMeta(item),
  onPress
}: {
  item: TaskItem
  first: boolean
  last: boolean
  /** The line under the title when the source picks its own facts, e.g. Linear's Show on rows. */
  meta?: string
  onPress: () => void
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const glyph = taskItemStateGlyph(item, colors)
  const status = taskRowStatus(item, t, colors)
  return (
    <View style={[styles.cell, first && styles.first, last && styles.last]}>
      <ListRow
        leading={<glyph.icon size={18} color={glyph.color} strokeWidth={2} />}
        title={item.title}
        subtitle={meta}
        subtitleLines={1}
        subtitleLead={status ?? undefined}
        accessibilityRole={item.provider === 'gitlabTodo' ? 'link' : 'button'}
        accessibilityLabel={[item.title, taskKindLabel(item), item.status, status?.text, meta]
          .filter(Boolean)
          .join(', ')}
        onPress={onPress}
      />
    </View>
  )
}

/** The hairline between two rows of a page group, from the text's start. */
export function MobileTaskRowSeparator() {
  const styles = useThemedStyles(stylesSheet)
  return (
    <View style={[styles.cell, styles.separator]}>
      <View style={styles.hairline} />
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  // Rows draw the group themselves so a long list stays one virtualized FlatList.
  cell: {
    marginHorizontal: spacing.lg,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  first: { borderTopLeftRadius: radii.surface, borderTopRightRadius: radii.surface },
  last: { borderBottomLeftRadius: radii.surface, borderBottomRightRadius: radii.surface },
  // A whole point tall so the rows below stay on device pixels and every hairline draws.
  separator: { height: 1 },
  hairline: {
    height: StyleSheet.hairlineWidth,
    marginLeft: LIST_LEADING_INSET,
    backgroundColor: colors.borderSubtle
  }
}))
