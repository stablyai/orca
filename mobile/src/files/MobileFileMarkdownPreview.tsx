import { MobileMarkdownPreviewImage } from './MobileMarkdownPreviewImage'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { ScrollView, View } from 'react-native'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { MobileFileAddressToolbar } from '../components/MobileFileAddressToolbar'
import { MOBILE_MARKDOWN_DOCUMENT_SCALE } from '../components/mobile-markdown-styles'
import {
  MobileFilePreviewSourceText,
  MobileFilePreviewTruncatedNote
} from './MobileFilePreviewSourceText'
import type { MarkdownPreviewMode } from './MobileMarkdownPreviewModeBar'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

type Props = {
  mode: MarkdownPreviewMode
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
  mode,
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

  return (
    <View style={styles.modeContainer}>
      <MobileFileAddressToolbar
        path={relativePath}
        viewMode={mode}
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
            textScale={MOBILE_MARKDOWN_DOCUMENT_SCALE}
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
