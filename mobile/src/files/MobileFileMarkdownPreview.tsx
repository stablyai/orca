import { MobileMarkdownPreviewImage } from './MobileMarkdownPreviewImage'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { MobileFileAddressToolbar } from '../components/MobileFileAddressToolbar'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  MobileFilePreviewSourceText,
  MobileFilePreviewTruncatedNote
} from './MobileFilePreviewSourceText'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

type Props = {
  relativePath: string
  content: string
  truncated: boolean
  byteLength: number
  client?: MobileFilePreviewRpcSender | null
  worktreeId?: string
  initialLine?: number
  initialLineSeq?: number
  showLineNumbers?: boolean
  onToggleLineNumbers?: () => void
  onOpenFile?: (pathText: string) => void
}

export function MobileFileMarkdownPreview({
  relativePath,
  content,
  truncated,
  byteLength,
  initialLine,
  initialLineSeq,
  showLineNumbers,
  onToggleLineNumbers,
  client,
  worktreeId,
  onOpenFile
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [mode, setMode] = useState<'preview' | 'source'>(() => (initialLine ? 'source' : 'preview'))
  const [previousRelativePath, setPreviousRelativePath] = useState(relativePath)
  const [previousInitialLine, setPreviousInitialLine] = useState(initialLine)
  // Switch modes before paint for a new file or line target; do not flash the previous manual mode.
  if (relativePath !== previousRelativePath || initialLine !== previousInitialLine) {
    setPreviousRelativePath(relativePath)
    setPreviousInitialLine(initialLine)
    setMode(initialLine ? 'source' : 'preview')
  }

  return (
    <View style={styles.modeContainer}>
      <MobileFileAddressToolbar
        path={relativePath}
        viewMode={mode}
        onViewModeChange={setMode}
        showLineNumbers={showLineNumbers}
        onToggleLineNumbers={onToggleLineNumbers}
        content={content}
        truncated={truncated}
        copyAccessibilityLabel={
          truncated
            ? t('files.fileMarkdownPreview.copyLoadedSource', 'Copy loaded Markdown source')
            : t('files.fileMarkdownPreview.copySource', 'Copy Markdown source')
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
          initialLineSeq={initialLineSeq}
          showLineNumbers={showLineNumbers}
        />
      )}
    </View>
  )
}
