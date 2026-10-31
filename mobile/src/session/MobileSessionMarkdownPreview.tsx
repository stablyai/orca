import { ScrollView } from 'react-native'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { MobileMarkdownPreviewImage } from '../files/MobileMarkdownPreviewImage'
import { MobileFilePreviewTruncatedNote } from '../files/MobileFilePreviewSourceText'
import type { MobileFilePreviewRpcSender } from '../files/mobile-file-preview-operations'
import { filePreviewStyles as styles } from '../files/mobile-file-preview-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

// Lifts the 13pt base to 14pt body text; headings scale with it.
const DOCUMENT_TEXT_SCALE = 14 / 13

type Props = {
  relativePath: string
  documentAbsolutePath?: string
  content: string
  truncated: boolean
  byteLength: number
  client?: MobileFilePreviewRpcSender | null
  worktreeId?: string
  onOpenFile?: (pathText: string) => void
}

export function MobileSessionMarkdownPreview({
  relativePath,
  documentAbsolutePath,
  content,
  truncated,
  byteLength,
  client,
  worktreeId,
  onOpenFile
}: Props) {
  useMobileColorScheme()
  return (
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
                  key={`${worktreeId}:${relativePath}:${documentAbsolutePath ?? ''}:${href}`}
                  client={client ?? null}
                  worktreeId={worktreeId}
                  documentPath={relativePath}
                  documentAbsolutePath={documentAbsolutePath}
                  href={href}
                  alt={alt}
                />
              )
            : undefined
        }
      />
    </ScrollView>
  )
}
