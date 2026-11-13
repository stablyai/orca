import { MobileMarkdownPreviewImage } from './MobileMarkdownPreviewImage'
import type { MobileFilePreviewRpcSender } from '../preview/mobile-file-preview-operations'
import { ScrollView } from 'react-native'
import { MobileMarkdown } from '../../components/MobileMarkdown'
import { MOBILE_MARKDOWN_DOCUMENT_SCALE } from '../../components/mobile-markdown-styles'
import {
  MobileFilePreviewSourceText,
  MobileFilePreviewTruncatedNote
} from '../preview/MobileFilePreviewSourceText'
import type { MarkdownPreviewMode } from './MobileMarkdownPreviewModeBar'
import { filePreviewStyles as styles } from '../preview/mobile-file-preview-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

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
  useMobileColorScheme()
  return mode === 'preview' ? (
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
    />
  )
}
