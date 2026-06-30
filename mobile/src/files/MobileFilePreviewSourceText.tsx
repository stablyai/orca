import { useMemo } from 'react'
import { ScrollView, Text } from 'react-native'
import { MobileSyntaxSegments } from '../components/MobileSyntaxSegments'
import { formatPreviewByteLength } from './mobile-file-preview-request'
import { buildMobileFilePreviewSyntax } from './mobile-file-preview-syntax'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

export function MobileFilePreviewSourceText({
  relativePath,
  content,
  truncated,
  byteLength
}: {
  relativePath: string
  content: string
  truncated?: boolean
  byteLength?: number
}) {
  const syntax = useMemo(
    () => buildMobileFilePreviewSyntax(relativePath, content),
    [content, relativePath]
  )
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.textContent}>
      {truncated ? (
        <MobileFilePreviewTruncatedNote byteLength={byteLength ?? content.length} />
      ) : null}
      <Text selectable style={styles.textPreview} accessibilityLabel="File preview">
        <MobileSyntaxSegments segments={syntax.segments} />
      </Text>
    </ScrollView>
  )
}

export function MobileFilePreviewTruncatedNote({ byteLength }: { byteLength: number }) {
  return (
    <Text style={styles.truncatedNote}>
      Preview truncated. File size: {formatPreviewByteLength(byteLength)}.
    </Text>
  )
}
