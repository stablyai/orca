import { MobileMarkdownPreviewImage } from './MobileMarkdownPreviewImage'
import type { MobileFilePreviewRpcSender } from '../preview/mobile-file-preview-operations'
import { ScrollView } from 'react-native'
import { MobileMarkdown } from '../../components/markdown/MobileMarkdown'
import { MOBILE_MARKDOWN_DOCUMENT_SCALE } from '../../components/markdown/mobile-markdown-styles'
import {
  MobileFilePreviewSourceText,
  MobileFilePreviewTruncatedNote
} from '../preview/MobileFilePreviewSourceText'
import type { MarkdownPreviewMode } from './MobileMarkdownPreviewModeBar'
import { filePreviewStylesSheet } from '../preview/mobile-file-preview-styles'
import { useThemedStyles } from '../../theme/themed-styles'

type Props = {
  mode: MarkdownPreviewMode
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
  mode,
  relativePath,
  content,
  truncated,
  byteLength,
  initialLine,
  client,
  worktreeId,
  onOpenFile
}: Props) {
  const styles = useThemedStyles(filePreviewStylesSheet)
  return mode === 'preview' ? (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.markdownContent}>
      {truncated ? <MobileFilePreviewTruncatedNote byteLength={byteLength} /> : null}
      <MobileMarkdown
        centerImageRows={Boolean(worktreeId)}
        content={content}
        textScale={MOBILE_MARKDOWN_DOCUMENT_SCALE}
        onOpenFile={onOpenFile}
        renderImage={
          worktreeId
            ? (href, alt, width) => (
                <MobileMarkdownPreviewImage
                  key={`${worktreeId}:${relativePath}:${href}`}
                  client={client ?? null}
                  worktreeId={worktreeId}
                  documentPath={relativePath}
                  href={href}
                  alt={alt}
                  width={width}
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
  )
}
