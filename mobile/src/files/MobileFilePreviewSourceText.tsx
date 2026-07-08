import { useEffect, useMemo, useRef } from 'react'
import { ScrollView, Text } from 'react-native'
import { MobileSyntaxSegments } from '../components/MobileSyntaxSegments'
import { formatPreviewByteLength } from './mobile-file-preview-request'
import { scrollOffsetForPreviewLine } from './mobile-file-preview-line-column'
import { buildMobileFilePreviewSyntax } from './mobile-file-preview-syntax'
import { createFilePreviewStyles } from './mobile-file-preview-styles'
import { useThemedStyles } from '../theme/theme-context'

export function MobileFilePreviewSourceText({
  relativePath,
  content,
  truncated,
  byteLength,
  initialLine
}: {
  relativePath: string
  content: string
  truncated?: boolean
  byteLength?: number
  initialLine?: number
}) {
  const styles = useThemedStyles(createFilePreviewStyles)
  const scrollRef = useRef<ScrollView>(null)
  const revealedRef = useRef(false)
  const syntax = useMemo(
    () => buildMobileFilePreviewSyntax(relativePath, content),
    [content, relativePath]
  )

  useEffect(() => {
    revealedRef.current = false
  }, [content, initialLine, relativePath])

  const revealInitialLine = () => {
    if (!initialLine || revealedRef.current) {
      return
    }
    revealedRef.current = true
    scrollRef.current?.scrollTo({
      y: scrollOffsetForPreviewLine(initialLine),
      animated: false
    })
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.textContent}
      onContentSizeChange={revealInitialLine}
    >
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
  const styles = useThemedStyles(createFilePreviewStyles)
  return (
    <Text style={styles.truncatedNote}>
      Preview truncated. File size: {formatPreviewByteLength(byteLength)}.
    </Text>
  )
}
