import { MobileMarkdownPreviewImage } from './MobileMarkdownPreviewImage'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { Code, Pencil } from 'lucide-react-native'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { MobileSourceCopyButton } from '../components/MobileSourceCopyButton'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  MobileFilePreviewSourceText,
  MobileFilePreviewTruncatedNote
} from './MobileFilePreviewSourceText'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

type Props = {
  relativePath: string
  content: string
  truncated: boolean
  byteLength: number
  client?: MobileFilePreviewRpcSender | null
  worktreeId?: string
  initialLine?: number
  onOpenFile?: (pathText: string) => void
}

export function MobileFileMarkdownPreview({
  relativePath,
  content,
  truncated,
  byteLength,
  initialLine,
  client,
  worktreeId,
  onOpenFile
}: Props) {
  useMobileColorScheme()
  const [mode, setMode] = useState<'preview' | 'source'>(() => (initialLine ? 'source' : 'preview'))
  const [previousRelativePath, setPreviousRelativePath] = useState(relativePath)
  const [previousInitialLine, setPreviousInitialLine] = useState(initialLine)
  // Switch modes before paint for a new file or line target; do not flash the previous manual mode.
  if (relativePath !== previousRelativePath || initialLine !== previousInitialLine) {
    setPreviousRelativePath(relativePath)
    setPreviousInitialLine(initialLine)
    setMode(initialLine ? 'source' : 'preview')
  }
  const previewSelected = mode === 'preview'
  const sourceSelected = mode === 'source'

  return (
    <View style={styles.modeContainer}>
      <View style={styles.modeToolbar}>
        <Pressable
          style={[styles.modeToggle, sourceSelected && styles.modeToggleActive]}
          onPress={() => setMode('source')}
          accessibilityRole="button"
          accessibilityState={{ selected: sourceSelected }}
          accessibilityLabel="View Markdown source"
        >
          <Code
            size={15}
            color={sourceSelected ? colors.textPrimary : colors.textSecondary}
            strokeWidth={2.2}
          />
        </Pressable>
        <Pressable
          style={[styles.modeToggle, previewSelected && styles.modeToggleActive]}
          onPress={() => setMode('preview')}
          accessibilityRole="button"
          accessibilityState={{ selected: previewSelected }}
          accessibilityLabel="View rendered Markdown preview"
        >
          <Pencil
            size={15}
            color={previewSelected ? colors.textPrimary : colors.textSecondary}
            strokeWidth={2.2}
          />
        </Pressable>
        <MobileSourceCopyButton
          key={relativePath}
          text={content}
          partial={truncated}
          accessibilityLabel={truncated ? 'Copy loaded Markdown source' : 'Copy Markdown source'}
        />
      </View>
      {mode === 'preview' ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.markdownContent}>
          {truncated ? <MobileFilePreviewTruncatedNote byteLength={byteLength} /> : null}
          <MobileMarkdown
            content={content}
            onOpenFile={onOpenFile}
            renderImage={
              worktreeId
                ? (href, alt) => (
                    <MobileMarkdownPreviewImage
                      key={`${worktreeId}:${relativePath}:${href}`}
                      client={client ?? null}
                      worktreeId={worktreeId}
                      documentPath={relativePath}
                      href={href}
                      alt={alt}
                    />
                  )
                : undefined
            }
          />
        </ScrollView>
      ) : (
        <MobileFilePreviewSourceText
          relativePath={relativePath}
          content={content}
          truncated={truncated}
          byteLength={byteLength}
          initialLine={initialLine}
        />
      )}
    </View>
  )
}
