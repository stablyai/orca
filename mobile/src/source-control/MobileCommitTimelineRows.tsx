import { memo } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { GitMerge } from 'lucide-react-native'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../src/shared/tui-agent-display-names'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import { initialsFor } from '../../../src/shared/user-initials'
import { colors, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import type { MobileTimelineRow } from './mobile-commit-timeline'
import { formatTimelineCommitTime, formatTimelineDay } from './mobile-commit-timeline-time'
import {
  MobileCommitTimelineLanes,
  MobileCommitTimelineNodeGraph,
  TIMELINE_GRAPH_LEFT,
  timelineGraphWidth
} from './MobileCommitTimelineGraph'
import type { ActionSheetAction } from '../components/ActionSheetModal'
import type { MobileSourceControlPrimaryAction } from './mobile-source-control-primary-action'

export type MobileTimelineUncommitted = {
  fileCount: number
  insertions: number | null
  deletions: number | null
}

export type MobileTimelineBase = {
  label: string
  commitsBehind: number | null
  update: ActionSheetAction | null
}

const TEXT_GAP = 6

function textStart(laneCount: number): number {
  return TIMELINE_GRAPH_LEFT + timelineGraphWidth(laneCount) + TEXT_GAP
}

function rowLaneCount(row: MobileTimelineRow): number {
  if (row.kind === 'group' || row.kind === 'day' || row.kind === 'truncated') {
    return row.lanes.length
  }
  return Math.max(row.graph.inputSwimlanes.length, row.graph.outputSwimlanes.length)
}

// Tabular +N −M for a commit, a file or uncommitted work; nothing when neither count is known.
export function CommitLineCounts({
  added,
  removed
}: {
  added: number | null | undefined
  removed: number | null | undefined
}) {
  if (!added && !removed) {
    return null
  }
  return (
    <Text style={styles.nums}>
      {added ? <Text style={styles.add}>+{added}</Text> : null}
      {added && removed ? ' ' : null}
      {removed ? <Text style={styles.del}>−{removed}</Text> : null}
    </Text>
  )
}

// The agent's mark when a commit credits one, otherwise the author's initials.
export function CommitAvatar({ agent, author }: { agent: TuiAgent | null; author: string }) {
  return (
    <View style={styles.avatar}>
      {agent ? (
        <MobileAgentIcon agentId={agent} size={12} />
      ) : (
        <Text style={styles.avatarText}>{initialsFor(author)}</Text>
      )}
    </View>
  )
}

function HeaderAction({ action }: { action: MobileSourceControlPrimaryAction }) {
  return (
    <Pressable
      onPress={action.onPress}
      disabled={action.disabled}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={action.accessibilityLabel}
      accessibilityHint={action.accessibilityHint}
      accessibilityState={{ disabled: action.disabled, busy: action.loading }}
      style={({ pressed }) => pressed && styles.pressed}
    >
      {action.loading ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : (
        <Text style={[styles.headerAction, action.disabled && styles.headerActionDisabled]}>
          {action.label}
        </Text>
      )}
    </Pressable>
  )
}

type RowProps = {
  row: MobileTimelineRow
  uncommitted: MobileTimelineUncommitted | null
  base: MobileTimelineBase | null
  pushAction: MobileSourceControlPrimaryAction | null
  nowMs: number
  todayStartMs: number
  historyLimit: number
  onOpenChanges: () => void
}

// Memoized: a timeline re-render passes the same row objects, so only changed rows rebuild their graph.
export const MobileCommitTimelineRow = memo(function MobileCommitTimelineRow({
  row,
  uncommitted,
  base,
  pushAction,
  nowMs,
  todayStartMs,
  historyLimit,
  onOpenChanges
}: RowProps) {
  const t = useMobileTranslation()
  const paddingLeft = textStart(rowLaneCount(row))
  switch (row.kind) {
    case 'uncommitted': {
      const fileCount = uncommitted?.fileCount ?? 0
      return (
        <Pressable
          style={({ pressed }) => [styles.item, { paddingLeft }, pressed && styles.pressed]}
          onPress={onOpenChanges}
          accessibilityRole="button"
          accessibilityHint={t('sourceControl.commitTimeline.openChangesHint', 'Opens Changes')}
        >
          <MobileCommitTimelineNodeGraph viewModel={row.graph} kind="uncommitted" />
          <Text style={styles.title} numberOfLines={1}>
            {t('sourceControl.commitTimeline.uncommitted', 'Uncommitted changes')}
          </Text>
          <View style={styles.meta}>
            <Text style={styles.metaText}>
              {fileCount === 1
                ? t('sourceControl.commitTimeline.files_one', '{{count}} file', {
                    count: fileCount
                  })
                : t('sourceControl.commitTimeline.files_other', '{{count}} files', {
                    count: fileCount
                  })}
            </Text>
            <View style={styles.spacer} />
            <CommitLineCounts added={uncommitted?.insertions} removed={uncommitted?.deletions} />
          </View>
        </Pressable>
      )
    }
    case 'group':
      return (
        <View style={[styles.header, { paddingLeft: paddingLeft + 4 }]}>
          <MobileCommitTimelineLanes lanes={row.lanes} />
          <Text style={styles.headerText}>
            {row.group === 'unpushed'
              ? t('sourceControl.commitTimeline.notPushed', 'Not pushed')
              : t('sourceControl.commitTimeline.onOrigin', 'On origin')}
          </Text>
          {row.group === 'unpushed' ? <Text style={styles.headerCount}>{row.count}</Text> : null}
          <View style={styles.spacer} />
          {row.group === 'unpushed' && pushAction ? <HeaderAction action={pushAction} /> : null}
        </View>
      )
    case 'day':
      return (
        <View style={[styles.header, { paddingLeft: paddingLeft + 4 }]}>
          <MobileCommitTimelineLanes lanes={row.lanes} />
          <Text style={styles.headerText}>{formatTimelineDay(row.dayStartMs, todayStartMs)}</Text>
        </View>
      )
    case 'commit': {
      const { commit } = row
      const author = commit.agent ? TUI_AGENT_DISPLAY_NAMES[commit.agent] : commit.author
      const time = formatTimelineCommitTime(commit.timestamp, nowMs, todayStartMs)
      return (
        <View style={[styles.item, { paddingLeft }]}>
          <MobileCommitTimelineNodeGraph
            viewModel={row.graph}
            kind={commit.unpushed ? 'unpushed' : 'pushed'}
          />
          <View style={styles.titleRow}>
            <Text style={[styles.title, styles.shrink]} numberOfLines={1}>
              {commit.subject ||
                t('sourceControl.gitHistory.noCommitMessage', '(no commit message)')}
            </Text>
            {commit.refs.slice(0, 2).map((ref) => (
              <Text key={ref} style={styles.ref} numberOfLines={1}>
                {ref}
              </Text>
            ))}
            {commit.refs.length > 2 ? (
              <Text style={styles.ref}>+{commit.refs.length - 2}</Text>
            ) : null}
          </View>
          <View style={styles.meta}>
            {author ? <CommitAvatar agent={commit.agent} author={commit.author} /> : null}
            {author ? (
              <Text style={[styles.metaText, styles.shrink]} numberOfLines={1}>
                {author}
              </Text>
            ) : null}
            {author && time ? <View style={styles.dot} /> : null}
            {time ? <Text style={styles.metaText}>{time}</Text> : null}
            <View style={styles.spacer} />
            <CommitLineCounts added={commit.insertions} removed={commit.deletions} />
          </View>
        </View>
      )
    }
    case 'base': {
      const behind = base?.commitsBehind ?? null
      const update = base?.update ?? null
      return (
        <View style={[styles.item, styles.baseItem, { paddingLeft }]}>
          <MobileCommitTimelineNodeGraph viewModel={row.graph} kind="base" />
          <View style={styles.titleRow}>
            <Text style={styles.baseTitle}>
              {t('sourceControl.commitTimeline.branchedFrom', 'Branched from')}
            </Text>
            <Text style={styles.baseRef} numberOfLines={1}>
              {base?.label}
            </Text>
          </View>
          {behind !== null ? (
            <Text style={[styles.metaText, styles.metaGap]} numberOfLines={1}>
              {behind > 0
                ? behind === 1
                  ? t('sourceControl.commitTimeline.baseAhead_one', '{{base}} has 1 newer commit', {
                      base: base?.label,
                      count: behind
                    })
                  : t(
                      'sourceControl.commitTimeline.baseAhead_other',
                      '{{base}} has {{count}} newer commits',
                      { base: base?.label, count: behind }
                    )
                : t('sourceControl.commitTimeline.baseCurrent', 'Up to date with {{base}}', {
                    base: base?.label
                  })}
            </Text>
          ) : null}
          {update && behind !== null && behind > 0 ? (
            <View style={styles.updateBlock}>
              <Pressable
                onPress={update.onPress}
                disabled={update.disabled}
                accessibilityRole="button"
                accessibilityState={{ disabled: update.disabled, busy: update.loading }}
                style={({ pressed }) => [
                  styles.updateButton,
                  update.disabled && styles.updateButtonDisabled,
                  pressed && styles.pressed
                ]}
              >
                {update.loading ? (
                  <ActivityIndicator size="small" color={colors.textPrimary} />
                ) : (
                  <GitMerge size={16} color={colors.textPrimary} strokeWidth={1.75} />
                )}
                <Text style={styles.updateText}>{update.label}</Text>
              </Pressable>
              {update.hint ? <Text style={styles.updateHint}>{update.hint}</Text> : null}
            </View>
          ) : null}
        </View>
      )
    }
    case 'truncated':
      return (
        <View style={[styles.header, { paddingLeft: paddingLeft + 4 }]}>
          <MobileCommitTimelineLanes lanes={row.lanes} />
          <Text style={styles.headerText}>
            {t('sourceControl.commitTimeline.truncated', 'Showing the latest {{count}} commits', {
              count: historyLimit
            })}
          </Text>
        </View>
      )
  }
})

const styles = themedStyleSheet(() => ({
  item: { paddingTop: 11, paddingBottom: 11, paddingRight: 16 },
  baseItem: { paddingBottom: 4 },
  pressed: { opacity: 0.6 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  title: { color: colors.textPrimary, fontSize: 16, lineHeight: 22, fontWeight: '500' },
  shrink: { flexShrink: 1 },
  ref: {
    flexShrink: 0,
    maxWidth: 120,
    color: colors.textSecondary,
    backgroundColor: colors.bgRaised,
    fontFamily: typography.monoFamily,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 6,
    borderRadius: 5,
    overflow: 'hidden'
  },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3, minWidth: 0 },
  metaGap: { marginTop: 3 },
  metaText: { color: colors.textMuted, fontSize: 13, lineHeight: 18 },
  spacer: { flex: 1 },
  dot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: colors.textMuted, opacity: 0.6 },
  nums: { fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
  add: { color: colors.gitDecorationAdded },
  del: { color: colors.gitDecorationDeleted },
  avatar: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  avatarText: { color: colors.textSecondary, fontSize: 8, fontWeight: '600' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 18,
    paddingBottom: 4,
    paddingRight: 20,
    minHeight: 40
  },
  headerText: { color: colors.textMuted, fontSize: 13, lineHeight: 18, fontWeight: '500' },
  headerCount: {
    color: colors.textMuted,
    opacity: 0.7,
    fontSize: 13,
    lineHeight: 18,
    fontVariant: ['tabular-nums']
  },
  headerAction: { color: colors.textPrimary, fontSize: 14, lineHeight: 18, fontWeight: '500' },
  headerActionDisabled: { color: colors.textMuted },
  baseTitle: { color: colors.textSecondary, fontSize: 16, lineHeight: 22 },
  baseRef: {
    flexShrink: 1,
    color: colors.textSecondary,
    backgroundColor: colors.bgRaised,
    fontFamily: typography.monoFamily,
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: 6,
    borderRadius: 5,
    overflow: 'hidden'
  },
  updateBlock: { marginTop: 14, alignItems: 'flex-start', gap: 6 },
  updateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 36,
    paddingLeft: 10,
    paddingRight: 14,
    borderRadius: 18,
    backgroundColor: colors.bgRaised
  },
  updateButtonDisabled: { opacity: 0.5 },
  updateText: { color: colors.textPrimary, fontSize: 15, fontWeight: '500' },
  updateHint: { color: colors.textMuted, fontSize: 13, lineHeight: 18 }
}))
