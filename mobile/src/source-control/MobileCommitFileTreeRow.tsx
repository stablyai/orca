import { Pressable, Text } from 'react-native'
import { ChevronRight, Folder } from 'lucide-react-native'
import { STATUS_LABELS } from '../../../src/shared/git-status-labels'
import { colors } from '../theme/mobile-theme'
import type { MobileGitChangedFile } from './git-compare-reply-schema'
import type { MobileCommitTreeNode } from './mobile-commit-files'
import { statusColor } from './mobile-source-control-screen-state'
import { commitDetailStyles as styles } from './mobile-commit-detail-styles'
import { CommitLineCounts } from './MobileCommitTimelineRows'

// One row of the commit's file tree, inside the grouped panel.
export function MobileCommitFileTreeRow({
  node,
  first,
  last,
  expanded,
  onToggleDirectory,
  onOpenFile
}: {
  node: MobileCommitTreeNode
  first: boolean
  last: boolean
  expanded: boolean
  onToggleDirectory: (key: string) => void
  onOpenFile: (file: MobileGitChangedFile) => void
}) {
  const rowStyle = ({ pressed }: { pressed: boolean }) => [
    styles.treeRow,
    first && styles.treeFirst,
    last && styles.treeLast,
    !first && styles.treeDivider,
    { paddingLeft: 16 + Math.max(node.depth, 0) * 18 },
    pressed && styles.treeRowPressed
  ]
  if (node.type === 'directory') {
    return (
      <Pressable
        onPress={() => onToggleDirectory(node.key)}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        style={rowStyle}
      >
        <Folder size={17} color={colors.textMuted} strokeWidth={1.75} />
        <Text style={styles.directoryName} numberOfLines={1}>
          {node.name}
        </Text>
      </Pressable>
    )
  }
  const status = node.entry.status ?? 'modified'
  return (
    <Pressable onPress={() => onOpenFile(node.entry)} accessibilityRole="button" style={rowStyle}>
      <Text style={[styles.statusLetter, { color: statusColor(status) }]}>
        {STATUS_LABELS[status]}
      </Text>
      <Text
        style={[styles.fileName, status === 'deleted' && styles.fileNameDeleted]}
        numberOfLines={1}
      >
        {node.name}
      </Text>
      <CommitLineCounts added={node.entry.added} removed={node.entry.removed} />
      <ChevronRight size={16} color={colors.textMuted} strokeWidth={1.75} />
    </Pressable>
  )
}
