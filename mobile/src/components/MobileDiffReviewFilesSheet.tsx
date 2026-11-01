import { useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, MessageSquare } from 'lucide-react-native'
import {
  buildSourceControlTree,
  compactSourceControlTree,
  flattenSourceControlTree,
  type SourceControlTreeNode
} from '../../../src/shared/source-control-tree'
import { STATUS_LABELS } from '../../../src/shared/git-status-labels'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileDiffReviewQueueItem } from '../session/mobile-diff-review-queue'
import { statusColor } from '../source-control/mobile-git-status'
import { colors, pressedStyle, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { DisclosureChevron } from './DisclosureChevron'
import { MobileSearchField } from './MobileSearchField'
import { SheetHeader } from './nav-bar/SheetHeader'
import {
  canMarkMobileDiffReviewItemViewed,
  MobileDiffLineStats,
  ViewedCheckbox
} from './MobileDiffReviewFileSummary'

type TreeEntry = { path: string; item: MobileDiffReviewQueueItem }

type Props = {
  queue: readonly MobileDiffReviewQueueItem[]
  currentKey: string | null
  subtitle: string
  onSelect: (item: MobileDiffReviewQueueItem) => void
  onToggleViewed: (item: MobileDiffReviewQueueItem) => void
  onClose: () => void
}

const TREE_AREA = 'files'
const INDENT = spacing.lg
const LETTER_WIDTH = 14

/** Jump to file: the screen's queue as desktop's compact folder tree, with search and viewed boxes. */
export function MobileDiffReviewFilesSheet({
  queue,
  currentKey,
  subtitle,
  onSelect,
  onToggleViewed,
  onClose
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const entries: TreeEntry[] = queue
      .filter((item) => !needle || item.filePath.toLowerCase().includes(needle))
      .map((item) => ({ path: item.filePath, item }))
    // Folders come first, as on desktop; files inside a folder keep the queue's next/previous order.
    const order = new Map(queue.map((item, index) => [item.key, index]))
    const tree = buildSourceControlTree(
      TREE_AREA,
      entries,
      (a, b) => (order.get(a.item.key) ?? 0) - (order.get(b.item.key) ?? 0)
    )
    return flattenSourceControlTree(compactSourceControlTree(tree), needle ? new Set() : collapsed)
  }, [collapsed, query, queue])

  const toggleFolder = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })

  return (
    <View style={styles.sheet}>
      <SheetHeader
        title={t('components.diffReviewFilesSheet.title', 'Files')}
        subtitle={subtitle}
        trailing={{ label: t('common.done', 'Done'), onPress: onClose }}
      />
      <MobileSearchField
        value={query}
        onChangeText={setQuery}
        placeholder={t('components.diffReviewFilesSheet.search', 'Jump to file')}
        style={styles.search}
      />
      <FlatList
        data={rows}
        // A path can be both staged and unstaged in the all-files queue; the queue key tells them apart.
        keyExtractor={(row) => (row.type === 'file' ? row.entry.item.key : row.key)}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item: row }) =>
          row.type === 'directory' ? (
            <FolderRow
              node={row}
              expanded={query.trim() !== '' || !collapsed.has(row.key)}
              onPress={() => toggleFolder(row.key)}
            />
          ) : (
            <FileRow
              item={row.entry.item}
              name={row.name}
              depth={row.depth}
              current={row.entry.item.key === currentKey}
              onPress={() => onSelect(row.entry.item)}
              onToggleViewed={() => onToggleViewed(row.entry.item)}
            />
          )
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {t('components.diffReviewFilesSheet.noMatches', 'No files match')}
          </Text>
        }
      />
    </View>
  )
}

function FolderRow({
  node,
  expanded,
  onPress
}: {
  node: SourceControlTreeNode<TreeEntry, string>
  expanded: boolean
  onPress: () => void
}) {
  useMobileColorScheme()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      style={({ pressed }) => [
        styles.folderRow,
        { paddingLeft: spacing.lg + node.depth * INDENT },
        pressed && pressedStyle
      ]}
    >
      <DisclosureChevron expanded={expanded} collapsedDeg={-90} expandedDeg={0}>
        <ChevronDown size={13} color={colors.textMuted} strokeWidth={2.2} />
      </DisclosureChevron>
      <Text style={styles.folderName} numberOfLines={1}>
        {node.name}
      </Text>
      {node.type === 'directory' ? <Text style={styles.count}>{node.fileCount}</Text> : null}
    </Pressable>
  )
}

function FileRow({
  item,
  name,
  depth,
  current,
  onPress,
  onToggleViewed
}: {
  item: MobileDiffReviewQueueItem
  name: string
  depth: number
  current: boolean
  onPress: () => void
  onToggleViewed: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const deleted = item.status === 'deleted'
  return (
    <View style={[styles.fileRow, { paddingLeft: spacing.lg + depth * INDENT }]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        // One path can be both staged and unstaged, so the label names which one this row opens.
        accessibilityLabel={`${item.filePath}, ${item.subtitle}`}
        accessibilityState={{ selected: current }}
        style={({ pressed }) => [styles.fileMain, pressed && pressedStyle]}
      >
        <Text style={[styles.status, { color: statusColor(item.status) }]}>
          {STATUS_LABELS[item.status]}
        </Text>
        <Text style={[styles.fileName, deleted && styles.deletedName]} numberOfLines={1}>
          {name}
        </Text>
        {current ? (
          <Text style={styles.currentPill}>
            {t('components.diffReviewFilesSheet.current', 'current')}
          </Text>
        ) : null}
        {item.noteCount > 0 ? (
          <View style={styles.notes}>
            <MessageSquare size={12} color={colors.textMuted} strokeWidth={2} />
            <Text style={styles.count}>{item.noteCount}</Text>
          </View>
        ) : null}
        <MobileDiffLineStats added={item.added} removed={item.removed} />
      </Pressable>
      {canMarkMobileDiffReviewItemViewed(item) ? (
        <ViewedCheckbox
          viewed={item.isReviewed}
          onPress={onToggleViewed}
          accessibilityLabel={t('components.diffReviewFilesSheet.viewedFile', '{{path}} viewed', {
            path: item.filePath
          })}
        />
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  sheet: {
    flex: 1,
    minHeight: 0
  },
  search: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm
  },
  folderRow: {
    minHeight: 36,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingRight: spacing.lg
  },
  folderName: {
    flex: 1,
    minWidth: 0,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  count: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  fileRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingRight: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  fileMain: {
    flex: 1,
    minWidth: 0,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  status: {
    width: LETTER_WIDTH,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  fileName: {
    flex: 1,
    minWidth: 0,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  deletedName: {
    color: colors.textMuted,
    textDecorationLine: 'line-through'
  },
  currentPill: {
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    color: colors.accentBlue,
    // The same blue tint the composer gives a picked skill.
    backgroundColor: colors.skillTokenSurface,
    fontSize: typography.metaSize
  },
  notes: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2
  },
  empty: {
    padding: spacing.xl,
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: typography.bodySize
  }
}))
