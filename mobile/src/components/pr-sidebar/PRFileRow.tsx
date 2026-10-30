import { memo } from 'react'
import { Pressable, Text, View } from 'react-native'
import {
  Check,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  Square,
  SquareCheck
} from 'lucide-react-native'
import { STATUS_LABELS } from '../../../../src/shared/git-status-labels'
import { mapPRFileStatus } from '../../../../src/shared/github/pull-request-file-state'
import { colors } from '../../theme/mobile-theme'
import { triggerSelection } from '../../platform/haptics'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { statusColor } from '../../source-control/mobile-source-control-screen-state'
import type { MobilePrFileRow } from '../../source-control/mobile-pr-file-rows'
import { prFilesStyles as styles } from './pr-files-styles'

const INDENT = 14

function ThreadBadge({ count }: { count: number }) {
  if (count === 0) {
    return null
  }
  return (
    <View style={styles.threadBadge}>
      <MessageSquare size={11} color={colors.textSecondary} strokeWidth={2.2} />
      <Text style={styles.threadBadgeText}>{count}</Text>
    </View>
  )
}

export const PRDirectoryRow = memo(function PRDirectoryRow({
  row,
  onToggle
}: {
  row: Extract<MobilePrFileRow, { kind: 'directory' }>
  onToggle: (key: string, expand: boolean) => void
}) {
  const t = useMobileTranslation()
  const allViewed = row.viewedCount === row.fileCount
  const Chevron = row.collapsed ? ChevronRight : ChevronDown
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: !row.collapsed }}
      accessibilityLabel={t(
        'components.prFiles.folderLabel',
        '{{name}}, {{viewed}} of {{total}} viewed',
        {
          name: row.name,
          viewed: row.viewedCount,
          total: row.fileCount
        }
      )}
      onPress={() => onToggle(row.key, row.collapsed)}
      style={({ pressed }) => [
        styles.row,
        { paddingLeft: 12 + row.depth * INDENT },
        pressed && styles.rowPressed
      ]}
    >
      <Chevron size={14} color={colors.textSecondary} strokeWidth={2.2} />
      <Text style={styles.directoryName} numberOfLines={1} ellipsizeMode="head">
        {row.name}
      </Text>
      <ThreadBadge count={row.threadCount} />
      {allViewed ? (
        <View style={styles.folderViewed}>
          <Text style={styles.folderCount}>{row.fileCount}</Text>
          <Check size={12} color={colors.statusGreen} strokeWidth={2.6} />
        </View>
      ) : (
        <Text style={styles.folderCount}>
          {row.viewedCount > 0 ? `${row.viewedCount}/${row.fileCount}` : row.fileCount}
        </Text>
      )}
    </Pressable>
  )
})

export const PRFileRow = memo(function PRFileRow({
  row,
  showDirectory,
  canMarkViewed,
  pending = false,
  onOpen,
  onToggleViewed
}: {
  row: Extract<MobilePrFileRow, { kind: 'file' }>
  /** Flat lists name the folder under the file; tree rows sit inside it. */
  showDirectory: boolean
  canMarkViewed: boolean
  /** A viewed write for this file is still in flight. */
  pending?: boolean
  onOpen?: (path: string) => void
  onToggleViewed: (path: string, viewed: boolean) => void
}) {
  const t = useMobileTranslation()
  const { file } = row
  const status = mapPRFileStatus(file.status)
  const ViewedIcon = row.viewed ? SquareCheck : Square
  return (
    <View style={[styles.row, styles.fileRow, { paddingLeft: 4 + row.depth * INDENT }]}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: row.viewed, disabled: !canMarkViewed || pending }}
        accessibilityLabel={t('components.prFiles.viewedToggle', 'Viewed {{path}}', {
          path: file.path
        })}
        disabled={!canMarkViewed || pending}
        hitSlop={4}
        onPress={() => {
          triggerSelection()
          onToggleViewed(file.path, !row.viewed)
        }}
        style={({ pressed }) => [
          styles.viewedHit,
          (!canMarkViewed || pending) && styles.viewedHitDisabled,
          pressed && styles.rowPressed
        ]}
      >
        <ViewedIcon
          size={18}
          color={row.viewed ? colors.statusGreen : colors.textMuted}
          strokeWidth={2}
        />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityHint={onOpen ? t('components.prFiles.openHint', 'Opens the diff') : undefined}
        disabled={!onOpen}
        onPress={() => {
          triggerSelection()
          onOpen?.(file.path)
        }}
        style={({ pressed }) => [styles.fileBody, pressed && styles.rowPressed]}
      >
        <Text style={[styles.statusLetter, { color: statusColor(status) }]}>
          {STATUS_LABELS[status]}
        </Text>
        <View style={styles.fileText}>
          <Text
            style={[styles.fileName, row.viewed && styles.fileNameViewed]}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {row.name}
          </Text>
          {showDirectory && row.directory ? (
            <Text style={styles.fileDirectory} numberOfLines={1} ellipsizeMode="head">
              {row.directory}
            </Text>
          ) : null}
        </View>
        {row.changedSinceViewed ? (
          <Text style={styles.changedPill}>{t('components.prFiles.changed', 'changed')}</Text>
        ) : null}
        <ThreadBadge count={row.threadCount} />
        <View style={styles.lineCounts}>
          {file.additions > 0 ? <Text style={styles.additions}>+{file.additions}</Text> : null}
          {file.deletions > 0 ? <Text style={styles.deletions}>−{file.deletions}</Text> : null}
        </View>
      </Pressable>
    </View>
  )
})
