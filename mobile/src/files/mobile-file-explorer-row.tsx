import { classifyMobileArtifact } from '../session/mobile-artifact-kind'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import {
  ChevronRight,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileCog,
  FileJson,
  FileTerminal,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  type LucideIcon
} from 'lucide-react-native'
import { triggerSelection } from '../platform/haptics'
import { colors } from '../theme/mobile-theme'
import { Button } from '../components/ui/Button'
import { pressTransition, slideTransition } from '../components/ui/transition-styles'
import { type FileExplorerRow, isMarkdownPath, type TreeNode } from './file-tree'
import {
  FILE_TREE_INDENT,
  FILE_TREE_ROW_PADDING,
  fileExplorerStyles as styles
} from './mobile-file-explorer-styles'
import { canPreviewMobileFileRow } from './mobile-file-preview-navigation'
import { mobileFileMediaMime } from './mobile-file-media'

type Props = {
  item: FileExplorerRow
  maximumIndentation: number
  expanded: ReadonlySet<string>
  onPreviewFile: (relativePath: string, displayName: string) => void
  onRetryDirectory: (relativePath: string) => void
  onToggleDirectory: (relativePath: string) => void
}

// Deep levels stop indenting at the cap, so long names stay reachable.
function indentFor(depth: number, maximumIndentation: number): number {
  return FILE_TREE_ROW_PADDING + Math.min(depth * FILE_TREE_INDENT, maximumIndentation)
}

export function MobileFileExplorerRow(props: Props) {
  const { item, maximumIndentation, expanded, onPreviewFile, onRetryDirectory, onToggleDirectory } =
    props
  const paddingLeft = indentFor(item.depth, maximumIndentation)

  if (item.kind === 'loading') {
    return (
      <View style={[styles.inlineStatusRow, { paddingLeft }]}>
        <View style={styles.chevronBox} />
        <ActivityIndicator size="small" color={colors.textSecondary} />
        <Text style={styles.inlineStatusText}>Loading…</Text>
      </View>
    )
  }

  if (item.kind === 'error') {
    return (
      <View style={[styles.inlineStatusRow, { paddingLeft }]}>
        <View style={styles.chevronBox} />
        <Text style={styles.inlineErrorText} numberOfLines={2}>
          {item.message || 'Unable to load folder.'}
        </Text>
        <Button
          label="Retry"
          size="compact"
          onPress={() => {
            triggerSelection()
            onRetryDirectory(item.relativePath)
          }}
          accessibilityLabel={`Retry loading ${item.relativePath}`}
        />
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

const CODE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cjs',
  'cpp',
  'cs',
  'css',
  'dart',
  'go',
  'h',
  'hpp',
  'html',
  'java',
  'js',
  'jsx',
  'kt',
  'less',
  'lua',
  'mjs',
  'php',
  'py',
  'rb',
  'rs',
  'scss',
  'sql',
  'svelte',
  'swift',
  'ts',
  'tsx',
  'vue',
  'zig'
])
const CONFIG_EXTENSIONS = new Set([
  'cfg',
  'conf',
  'env',
  'ini',
  'lock',
  'plist',
  'toml',
  'yaml',
  'yml'
])
const SHELL_EXTENSIONS = new Set(['bash', 'fish', 'ps1', 'sh', 'zsh'])
const ARCHIVE_EXTENSIONS = new Set(['7z', 'gz', 'rar', 'tar', 'tgz', 'zip'])

function fileIconFor(relativePath: string): LucideIcon {
  if (isMarkdownPath(relativePath)) {
    return FileText
  }
  if (classifyMobileArtifact(relativePath) === 'image') {
    return ImageIcon
  }
  const mime = mobileFileMediaMime(relativePath)
  if (mime?.startsWith('video/')) {
    return FileVideo
  }
  if (mime?.startsWith('audio/')) {
    return FileAudio
  }
  const name = relativePath.split('/').pop() ?? relativePath
  const dot = name.lastIndexOf('.')
  const extension = dot !== -1 ? name.slice(dot + 1).toLowerCase() : ''
  if (extension === 'json' || extension === 'jsonc') {
    return FileJson
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return FileCode
  }
  if (SHELL_EXTENSIONS.has(extension)) {
    return FileTerminal
  }
  if (CONFIG_EXTENSIONS.has(extension) || name.startsWith('.')) {
    return FileCog
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return FileArchive
  }
  return File
}

function TreeRow(props: {
  item: TreeNode
  paddingLeft: number
  expanded: ReadonlySet<string>
  onPreviewFile: (relativePath: string, displayName: string) => void
  onToggleDirectory: (relativePath: string) => void
}) {
  const { item, paddingLeft, expanded, onPreviewFile, onToggleDirectory } = props
  const isDirectory = item.kind === 'directory'
  const isExpanded = expanded.has(item.relativePath)
  const previewable =
    item.kind !== 'directory' &&
    canPreviewMobileFileRow({ kind: item.kind, relativePath: item.relativePath })
  const disabled = item.kind === 'binary' && !previewable
  const Icon = isDirectory ? (isExpanded ? FolderOpen : Folder) : fileIconFor(item.relativePath)

  return (
    <Pressable
      disabled={disabled}
      onPress={() => {
        triggerSelection()
        if (isDirectory) {
          onToggleDirectory(item.relativePath)
        } else if (!disabled) {
          onPreviewFile(item.relativePath, item.name)
        }
      }}
      accessibilityRole="button"
      accessibilityState={isDirectory ? { expanded: isExpanded } : { disabled }}
      accessibilityLabel={
        isDirectory
          ? `Open folder ${item.name}`
          : disabled
            ? `${item.name} unavailable on mobile`
            : `Preview file ${item.name}`
      }
    >
      {({ pressed }) => (
        <View
          style={[
            styles.row,
            { paddingLeft },
            pressed && !disabled && styles.rowPressed,
            disabled && styles.rowDisabled,
            pressed ? pressTransition.pressed : pressTransition.rest
          ]}
        >
          <View
            style={[
              styles.chevronBox,
              isExpanded ? styles.chevronExpanded : styles.chevronCollapsed,
              slideTransition
            ]}
          >
            {isDirectory ? (
              <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
            ) : null}
          </View>
          <Icon
            size={18}
            color={disabled ? colors.textMuted : colors.textSecondary}
            strokeWidth={1.9}
            style={styles.icon}
          />
          <Text style={[styles.rowTitle, disabled && styles.rowTitleDisabled]} numberOfLines={1}>
            {item.name}
          </Text>
          {disabled ? <Text style={styles.rowTrailing}>Not on mobile</Text> : null}
        </View>
      )}
    </Pressable>
  )
}
