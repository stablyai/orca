import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
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
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { type FileExplorerRow, isMarkdownPath, type TreeNode } from './file-tree'
import { fileExplorerStyles as styles } from './mobile-file-explorer-styles'
import { canPreviewMobileFileRow } from './mobile-file-preview-navigation'

type Props = {
  item: FileExplorerRow
  maximumIndentation: number
  expanded: ReadonlySet<string>
  onPreviewFile: (relativePath: string, displayName: string) => void
  onRetryDirectory: (relativePath: string) => void
  onToggleDirectory: (relativePath: string) => void
}

export function MobileFileExplorerRow(props: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { item, maximumIndentation, expanded, onPreviewFile, onRetryDirectory, onToggleDirectory } =
    props
  const paddingLeft = spacing.lg + Math.min(item.depth * 18, maximumIndentation)

  if (item.kind === 'loading') {
    return (
      <View style={[styles.inlineStatusRow, { paddingLeft }]}>
        <View style={styles.chevronSpacer} />
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={styles.inlineStatusText}>
          {t('files.fileExplorerRow.loading', 'Loading...')}
        </Text>
      </View>
    )
  }

  if (item.kind === 'error') {
    return (
      <View style={[styles.inlineStatusRow, { paddingLeft }]}>
        <View style={styles.chevronSpacer} />
        <Text style={styles.inlineErrorText} numberOfLines={1}>
          {item.message || t('files.fileExplorerRow.loadFolderFailed', 'Unable to load folder')}
        </Text>
        <Pressable
          style={({ pressed }) => [styles.inlineRetryButton, pressed && styles.rowPressed]}
          onPress={() => {
            triggerSelection()
            onRetryDirectory(item.relativePath)
          }}
          accessibilityLabel={t('files.fileExplorerRow.retryLoading', 'Retry loading {{path}}', {
            path: item.relativePath
          })}
        >
          <Text style={styles.inlineRetryText}>{t('common.retry', 'Retry')}</Text>
        </Pressable>
      </View>
    )
  }

  if (isTreeNode(item)) {
    return (
      <TreeRow
        item={item}
        paddingLeft={paddingLeft}
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
  paddingLeft: number
  expanded: ReadonlySet<string>
  onPreviewFile: (relativePath: string, displayName: string) => void
  onToggleDirectory: (relativePath: string) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { item, paddingLeft, expanded, onPreviewFile, onToggleDirectory } = props
  const isDirectory = item.kind === 'directory'
  const isExpanded = expanded.has(item.relativePath)
  const previewable =
    item.kind !== 'directory' &&
    canPreviewMobileFileRow({ kind: item.kind, relativePath: item.relativePath })
  const isImage = item.kind === 'binary' && classifyMobileArtifact(item.relativePath) === 'image'
  const disabled = item.kind === 'binary' && !previewable
  const markdown = item.kind === 'text' && isMarkdownPath(item.relativePath)

  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        { paddingLeft },
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
          ? t('files.fileExplorerRow.openFolder', 'Open folder {{name}}', { name: item.name })
          : disabled
            ? t('files.fileExplorerRow.fileUnavailable', '{{name}} unavailable on mobile', {
                name: item.name
              })
            : t('files.fileExplorerRow.previewFile', 'Preview file {{name}}', { name: item.name })
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
        {disabled ? (
          <Text style={styles.rowMeta}>
            {t('files.fileExplorerRow.unavailable', 'Unavailable on mobile')}
          </Text>
        ) : null}
      </View>
    </Pressable>
  )
}
