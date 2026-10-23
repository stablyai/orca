import { MobileMarkdownPreviewImage } from './MobileMarkdownPreviewImage'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { MobileSourceCopyButton } from '../components/MobileSourceCopyButton'
import {
  MobilePreviewModeToolbar,
  type MobilePreviewMode
} from '../components/MobilePreviewModeToolbar'
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
  const [mode, setMode] = useState<MobilePreviewMode>(() => (initialLine ? 'source' : 'preview'))
  const [previousRelativePath, setPreviousRelativePath] = useState(relativePath)
  const [previousInitialLine, setPreviousInitialLine] = useState(initialLine)
  // Why: opening a different file or line target must switch modes before paint,
  // never briefly retain the prior file's manually selected mode.
  if (relativePath !== previousRelativePath || initialLine !== previousInitialLine) {
    setPreviousRelativePath(relativePath)
    setPreviousInitialLine(initialLine)
    setMode(initialLine ? 'source' : 'preview')
  }

  return (
    <View style={styles.modeContainer}>
      <MobilePreviewModeToolbar
        mode={mode}
        onModeChange={setMode}
        testIDPrefix="markdown-preview-mode-"
        trailing={
          <MobileSourceCopyButton
            key={relativePath}
            text={content}
            partial={truncated}
            accessibilityLabel={truncated ? 'Copy loaded Markdown source' : 'Copy Markdown source'}
          />
        }
      />
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
