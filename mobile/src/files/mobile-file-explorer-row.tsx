import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Folder,
  Image as ImageIcon
} from 'lucide-react-native'
import { triggerSelection } from '../platform/haptics'
import { colors, spacing } from '../theme/mobile-theme'
import { type FileExplorerRow, isMarkdownPath, type TreeNode } from './file-tree'
import { fileExplorerStyles as styles } from './mobile-file-explorer-styles'
import { canPreviewMobileFileRow } from './mobile-file-preview-navigation'

type Props = {
  item: FileExplorerRow
  expanded: ReadonlySet<string>
  onPreviewFile: (relativePath: string, displayName: string) => void
  onRetryDirectory: (relativePath: string) => void
  onToggleDirectory: (relativePath: string) => void
}

export function MobileFileExplorerRow(props: Props) {
  const { item, expanded, onPreviewFile, onRetryDirectory, onToggleDirectory } = props

  if (item.kind === 'loading') {
    return (
      <View style={[styles.inlineStatusRow, { paddingLeft: spacing.lg + item.depth * 18 }]}>
        <View style={styles.chevronSpacer} />
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={styles.inlineStatusText}>Loading...</Text>
      </View>
    )
  }

  if (item.kind === 'error') {
    return (
      <View style={[styles.inlineStatusRow, { paddingLeft: spacing.lg + item.depth * 18 }]}>
        <View style={styles.chevronSpacer} />
        <Text style={styles.inlineErrorText} numberOfLines={1}>
          {item.message || 'Unable to load folder'}
        </Text>
        <Pressable
          style={({ pressed }) => [styles.inlineRetryButton, pressed && styles.rowPressed]}
          onPress={() => {
            triggerSelection()
            onRetryDirectory(item.relativePath)
          }}
          accessibilityLabel={`Retry loading ${item.relativePath}`}
        >
          <Text style={styles.inlineRetryText}>Retry</Text>
        </Pressable>
      </View>
    )
  }

  if (isTreeNode(item)) {
    return (
      <TreeRow
        item={item}
        expanded={expanded}
        onPreviewFile={onPreviewFile}
        onToggleDirectory={onToggleDirectory}
      />
    )
  }

  return null
}

function isTreeNode(item: FileExplorerRow): item is TreeNode {
  return item.kind === 'directory' || item.kind === 'text' || item.kind === 'binary'
}

function TreeRow(props: {
  item: TreeNode
  expanded: ReadonlySet<string>
  onPreviewFile: (relativePath: string, displayName: string) => void
  onToggleDirectory: (relativePath: string) => void
}) {
  const { item, expanded, onPreviewFile, onToggleDirectory } = props
  const isDirectory = item.kind === 'directory'
  const isExpanded = expanded.has(item.relativePath)
  // Images render in the mobile viewer (via files.readPreview), so a binary
  // image is openable; only non-previewable binaries are unavailable.
  const previewable =
    item.kind !== 'directory' &&
    canPreviewMobileFileRow({ kind: item.kind, relativePath: item.relativePath })
  const isImage = item.kind === 'binary' && previewable
  const disabled = item.kind === 'binary' && !previewable
  const markdown = item.kind === 'text' && isMarkdownPath(item.relativePath)

  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        { paddingLeft: spacing.lg + item.depth * 18 },
        pressed && !disabled && styles.rowPressed,
        disabled && styles.rowDisabled
      ]}
      disabled={disabled}
      onPress={() => {
        triggerSelection()
        if (isDirectory) {
          onToggleDirectory(item.relativePath)
        } else if (!disabled) {
          onPreviewFile(item.relativePath, item.name)
        }
      }}
      accessibilityLabel={
        isDirectory
          ? `Open folder ${item.name}`
          : disabled
            ? `${item.name} unavailable on mobile`
            : `Preview file ${item.name}`
      }
    >
      {isDirectory ? (
        isExpanded ? (
          <ChevronDown size={16} color={colors.textSecondary} />
        ) : (
          <ChevronRight size={16} color={colors.textSecondary} />
        )
      ) : (
        <View style={styles.chevronSpacer} />
      )}
      {isDirectory ? (
        <Folder size={17} color={colors.textSecondary} />
      ) : markdown ? (
        <FileText size={17} color={disabled ? colors.textMuted : colors.textSecondary} />
      ) : isImage ? (
        <ImageIcon size={17} color={colors.textSecondary} />
      ) : (
        <File size={17} color={disabled ? colors.textMuted : colors.textSecondary} />
      )}
      <View style={styles.rowTextBlock}>
        <Text style={[styles.rowTitle, disabled && styles.rowTitleDisabled]} numberOfLines={1}>
          {item.name}
        </Text>
        {disabled ? <Text style={styles.rowMeta}>Unavailable on mobile</Text> : null}
      </View>
    </Pressable>
  )
}
