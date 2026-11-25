import { classifyMobileArtifact } from '../preview/mobile-artifact-kind'
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle
} from 'react-native'
import {
  ChevronDown,
  ChevronRight,
  CircleSlash,
  File,
  FileText,
  Folder,
  Image as ImageIcon,
  Link
} from 'lucide-react-native'
import { STATUS_LABELS } from '../../../../src/shared/git/status/git-status-labels'
import type { GitFileStatus } from '../../../../src/shared/git/status/git-status-types'
import { statusColor } from '../../source-control/changes/mobile-git-status'
import type { DecorateFileRow } from './use-mobile-file-explorer-decorations'
import { triggerMediumImpact, triggerSelection } from '../../platform/haptics/haptics'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, spacing } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import {
  DIRECTORY_PAGE_SIZE,
  type FileExplorerRow,
  type FolderPagingNode,
  isMarkdownPath,
  type TreeNode
} from './file-tree'
import type { FolderPagingStatus } from './use-mobile-file-explorer-paging'
import { getUiIntlLocale } from '../../i18n/ui-intl-locale'
import { fileExplorerStyles as styles } from './mobile-file-explorer-styles'
import { canPreviewMobileFileRow } from '../preview/mobile-file-preview-navigation'
import { TailClippedText } from '../../components/list/TailClippedText'

type Props = {
  item: FileExplorerRow
  maximumIndentation: number
  expanded: ReadonlySet<string>
  decorate: DecorateFileRow
  onPreviewFile: (relativePath: string, displayName: string) => void
  onRetryDirectory: (relativePath: string) => void
  onToggleDirectory: (relativePath: string) => void
  onOpenActions: (node: TreeNode) => void
  folderPaging: ReadonlyMap<string, FolderPagingStatus>
  onShowMore: (relativePath: string) => void
}

function formatCount(count: number): string {
  return count.toLocaleString(getUiIntlLocale())
}

export function MobileFileExplorerRow(props: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const {
    item,
    maximumIndentation,
    expanded,
    decorate,
    onPreviewFile,
    onRetryDirectory,
    onToggleDirectory,
    onOpenActions,
    folderPaging,
    onShowMore
  } = props
  const paddingLeft = spacing.lg + Math.min(item.depth * 18, maximumIndentation)

  if (item.kind === 'loading') {
    return (
      <View style={[styles.inlineStatusRow, { paddingLeft }]}>
        <View style={styles.chevronSpacer} />
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={styles.inlineStatusText}>
          {t('files.fileExplorerRow.loadingFolder', 'Loading…')}
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
          onPress={() => onRetryDirectory(item.relativePath)}
          accessibilityLabel={t('files.fileExplorerRow.retryLoading', 'Retry loading {{path}}', {
            path: item.relativePath
          })}
        >
          <Text style={styles.inlineRetryText}>{t('common.retry', 'Retry')}</Text>
        </Pressable>
      </View>
    )
  }

  if (item.kind === 'more') {
    return (
      <FolderPagingRow
        item={item}
        paddingLeft={paddingLeft}
        status={folderPaging.get(item.relativePath)}
        onShowMore={onShowMore}
      />
    )
  }

  if (isTreeNode(item)) {
    return (
      <TreeRow
        item={item}
        paddingLeft={paddingLeft}
        expanded={expanded}
        decorate={decorate}
        onPreviewFile={onPreviewFile}
        onToggleDirectory={onToggleDirectory}
        onOpenActions={onOpenActions}
      />
    )
  }

  return null
}

function FolderPagingRow(props: {
  item: FolderPagingNode
  paddingLeft: number
  status: FolderPagingStatus | undefined
  onShowMore: (relativePath: string) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { item, paddingLeft, status, onShowMore } = props
  const counts = { loaded: formatCount(item.loaded), total: formatCount(item.total) }
  const busy = status === 'loading'

  if (status === 'failed') {
    return (
      <View style={[styles.inlineStatusRow, { paddingLeft }]}>
        <View style={styles.chevronSpacer} />
        <Text style={styles.inlineErrorText} numberOfLines={1}>
          {t('files.fileExplorerRow.loadFolderFailed', 'Unable to load folder')}
        </Text>
        <Pressable
          style={({ pressed }) => [styles.inlineRetryButton, pressed && styles.rowPressed]}
          onPress={() => onShowMore(item.relativePath)}
          accessibilityLabel={t('files.fileExplorerRow.retryLoading', 'Retry loading {{path}}', {
            path: item.relativePath
          })}
        >
          <Text style={styles.inlineRetryText}>{t('common.retry', 'Retry')}</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <Pressable
      style={({ pressed }) => [styles.row, { paddingLeft }, pressed && styles.rowPressed]}
      disabled={busy}
      onPress={() => onShowMore(item.relativePath)}
    >
      <View style={styles.chevronSpacer} />
      {busy ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
      <Text style={[styles.rowTextBlock, styles.showMoreText]} numberOfLines={1}>
        {busy
          ? t('files.fileExplorerRow.loadingFolder', 'Loading…')
          : t('files.fileExplorerRow.showMore', 'Show {{rows}} more', {
              rows: formatCount(Math.min(DIRECTORY_PAGE_SIZE, item.total - item.loaded))
            })}
      </Text>
      <Text style={styles.entryCount}>
        {t('files.fileExplorerRow.loadedOfTotal', '{{loaded}} of {{total}}', counts)}
      </Text>
    </Pressable>
  )
}

// As desktop's tree: a modified name is amber, so it doesn't read as dimmed like an ignored one.
function treeStatusColor(status: GitFileStatus): string {
  return status === 'modified' ? colors.gitDecorationModified : statusColor(status)
}

function isTreeNode(item: FileExplorerRow): item is TreeNode {
  return item.kind === 'directory' || item.kind === 'text' || item.kind === 'binary'
}

function TreeRow(props: {
  item: TreeNode
  paddingLeft: number
  expanded: ReadonlySet<string>
  decorate: DecorateFileRow
  onPreviewFile: (relativePath: string, displayName: string) => void
  onToggleDirectory: (relativePath: string) => void
  onOpenActions: (node: TreeNode) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const { item, paddingLeft, expanded, decorate, onPreviewFile, onToggleDirectory, onOpenActions } =
    props
  const isDirectory = item.kind === 'directory'
  const { status, ignored } = decorate(item.relativePath, isDirectory)
  const decorationColor = status ? treeStatusColor(status) : ignored ? colors.textMuted : undefined
  const isExpanded = expanded.has(item.relativePath)
  const previewable =
    item.kind !== 'directory' &&
    canPreviewMobileFileRow({ kind: item.kind, relativePath: item.relativePath })
  const isImage = item.kind === 'binary' && classifyMobileArtifact(item.relativePath) === 'image'
  const disabled = item.kind === 'binary' && !previewable
  const markdown = item.kind === 'text' && isMarkdownPath(item.relativePath)
  // A search result sits flush left with its folder under the name; tree rows indent instead.
  const result = item.folder !== undefined

  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        result ? styles.resultRow : { paddingLeft },
        pressed && !disabled && styles.rowPressed,
        disabled && styles.rowDisabled
      ]}
      // Unpreviewable files still long-press for their actions, so the row stays enabled.
      accessibilityState={{ disabled }}
      onLongPress={() => {
        triggerMediumImpact()
        onOpenActions(item)
      }}
      delayLongPress={400}
      onPress={() => {
        if (isDirectory) {
          // Expanding a folder toggles in place; opening a file navigates and stays quiet.
          triggerSelection()
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
      {result ? null : isDirectory ? (
        isExpanded ? (
          <ChevronDown size={16} color={colors.textSecondary} />
        ) : (
          <ChevronRight size={16} color={colors.textSecondary} />
        )
      ) : (
        <View style={styles.chevronSpacer} />
      )}
      <View style={styles.iconSlot}>
        {isDirectory ? (
          <Folder size={18} color={colors.textSecondary} />
        ) : item.isSymlink ? (
          <Link size={18} color={colors.textSecondary} />
        ) : markdown ? (
          <FileText size={18} color={colors.textSecondary} />
        ) : isImage ? (
          <ImageIcon size={18} color={colors.textSecondary} />
        ) : (
          <File size={18} color={colors.textSecondary} />
        )}
      </View>
      <View style={styles.rowTextBlock}>
        <FileName
          name={item.name}
          style={[
            styles.rowTitle,
            decorationColor !== undefined && { color: decorationColor },
            ignored && styles.rowTitleIgnored
          ]}
        />
        {result && item.folder ? (
          <TailClippedText style={styles.rowFolder}>{item.folder}</TailClippedText>
        ) : null}
      </View>
      {item.entryCount !== undefined ? (
        <Text style={styles.entryCount}>{formatCount(item.entryCount)}</Text>
      ) : null}
      {status ? (
        <Text style={[styles.statusLetter, { color: decorationColor }]}>
          {STATUS_LABELS[status]}
        </Text>
      ) : ignored ? (
        <CircleSlash
          size={13}
          color={colors.textMuted}
          accessibilityLabel={t('files.fileExplorerRow.ignored', 'Ignored by .gitignore')}
        />
      ) : null}
    </Pressable>
  )
}

// Room kept for the end of a long name: its extension and a few letters before it.
const NAME_END = 6

/** One line that cuts a long file name in the middle, so `a.test.ts` and `a.ts` stay apart (the page ignores ellipsizeMode). */
function FileName({ name, style }: { name: string; style: StyleProp<TextStyle> }) {
  const dot = name.lastIndexOf('.')
  const keep = dot > 0 ? name.length - dot + NAME_END : NAME_END * 2
  if (name.length <= keep * 2) {
    return (
      <Text style={style} numberOfLines={1}>
        {name}
      </Text>
    )
  }
  return (
    <View style={styles.name}>
      <Text style={[style, styles.nameStart]} numberOfLines={1}>
        {name.slice(0, -keep)}
      </Text>
      <Text style={[style, styles.nameEnd]} numberOfLines={1}>
        {name.slice(-keep)}
      </Text>
    </View>
  )
}
