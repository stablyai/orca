import { MobileMarkdownPreviewImage } from './MobileMarkdownPreviewImage'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { ScrollView } from 'react-native'
import { MobileMarkdown } from '../components/MobileMarkdown'
import {
  MobileFilePreviewSourceText,
  MobileFilePreviewTruncatedNote
} from './MobileFilePreviewSourceText'
import type { MarkdownPreviewMode } from './MobileMarkdownPreviewModeBar'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Lifts the 13pt base to 14pt body text; headings scale with it.
const DOCUMENT_TEXT_SCALE = 14 / 13

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
        textScale={DOCUMENT_TEXT_SCALE}
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
