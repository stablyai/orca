import { useEffect, useMemo, useRef } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { MobileSyntaxSegments } from '../components/MobileSyntaxSegments'
import type { MobileSyntaxSegment } from '../session/mobile-file-syntax'
import { formatPreviewByteLength } from './mobile-file-preview-request'
import { scrollOffsetForPreviewLine } from './mobile-file-preview-line-column'
import { buildMobileFilePreviewSyntax } from './mobile-file-preview-syntax'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

export function splitSyntaxSegmentsIntoLines(
  segments: readonly MobileSyntaxSegment[]
): MobileSyntaxSegment[][] {
  const lines: MobileSyntaxSegment[][] = [[]]
  for (const segment of segments) {
    const parts = segment.text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push([])
      }
      const partText = parts[i]
      if (partText.length > 0) {
        lines[lines.length - 1].push({ text: partText, kind: segment.kind })
      }
    }
  }
  return lines
}

export function MobileFilePreviewSourceText({
  relativePath,
  content,
  truncated,
  byteLength,
  initialLine,
  initialLineSeq,
  showLineNumbers = true,
  initialScrollRatio,
  onScrollRatioChange
}: {
  relativePath: string
  content: string
  truncated?: boolean
  byteLength?: number
  initialLine?: number
  initialLineSeq?: number
  showLineNumbers?: boolean
  initialScrollRatio?: number
  onScrollRatioChange?: (ratio: number) => void
}) {
  useMobileColorScheme()
  const scrollRef = useRef<ScrollView>(null)
  const contentHeightRef = useRef(0)
  const layoutHeightRef = useRef(0)
  const revealedKeyRef = useRef<string | null>(null)
  const restoredRatioRef = useRef(false)
  const initialScrollRatioRef = useRef(initialScrollRatio)
  const onScrollRatioChangeRef = useRef(onScrollRatioChange)

  useEffect(() => {
    onScrollRatioChangeRef.current = onScrollRatioChange
  }, [onScrollRatioChange])

  const restoreInitialRatio = (height?: number) => {
    if (
      restoredRatioRef.current ||
      initialLine ||
      typeof initialScrollRatioRef.current !== 'number' ||
      initialScrollRatioRef.current <= 0 ||
      !scrollRef.current
    ) {
      return
    }
    const ch = height ?? contentHeightRef.current
    const lh = layoutHeightRef.current
    if (ch > 0 && lh > 0) {
      const maxScroll = ch - lh
      if (maxScroll > 0) {
        scrollRef.current.scrollTo({
          y: initialScrollRatioRef.current * maxScroll,
          animated: false
        })
        restoredRatioRef.current = true
      }
    }
  }

  const syntax = useMemo(
    () => buildMobileFilePreviewSyntax(relativePath, content),
    [content, relativePath]
  )

  const lines = useMemo(
    () => (showLineNumbers ? splitSyntaxSegmentsIntoLines(syntax.segments) : null),
    [showLineNumbers, syntax.segments]
  )

  const lineNumberWidth = useMemo(() => {
    if (!lines) {
      return 18
    }
    const digits = Math.max(1, String(lines.length).length)
    return Math.max(18, Math.ceil(digits * 7.5) + 8)
  }, [lines])

  const revealTargetKey = initialLine
    ? `${relativePath}:${initialLine}:${initialLineSeq ?? 0}`
    : null

  const revealInitialLine = (height?: number) => {
    if (
      !initialLine ||
      !revealTargetKey ||
      revealedKeyRef.current === revealTargetKey ||
      !scrollRef.current
    ) {
      return
    }
    scrollRef.current.scrollTo({
      y: scrollOffsetForPreviewLine(initialLine),
      animated: false
    })
    if (typeof height === 'number' && height > 0) {
      revealedKeyRef.current = revealTargetKey
    }
  }

  useEffect(() => {
    if (contentHeightRef.current > 0) {
      revealInitialLine(contentHeightRef.current)
    }
  }, [initialLine, initialLineSeq, relativePath])

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={
        showLineNumbers && lines ? styles.textContentWithLines : styles.textContent
      }
      onLayout={(event) => {
        layoutHeightRef.current = event.nativeEvent.layout.height
        restoreInitialRatio()
      }}
      onContentSizeChange={(_width, height) => {
        contentHeightRef.current = height
        revealInitialLine(height)
        restoreInitialRatio(height)
      }}
      onScroll={(event) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
        const maxScroll = contentSize.height - layoutMeasurement.height
        if (maxScroll > 0) {
          const ratio = Math.max(0, Math.min(1, contentOffset.y / maxScroll))
          onScrollRatioChangeRef.current?.(ratio)
        }
      }}
      scrollEventThrottle={16}
    >
      {truncated ? (
        <MobileFilePreviewTruncatedNote byteLength={byteLength ?? content.length} />
      ) : null}
      {showLineNumbers && lines ? (
        <View style={styles.sourceLinesContainer} accessibilityLabel="File preview">
          {lines.map((lineSegments, lineIndex) => (
            <View key={lineIndex} style={styles.sourceLineRow}>
              <Text
                style={[
                  styles.sourceLineNumber,
                  { width: lineNumberWidth, minWidth: lineNumberWidth, flexShrink: 0 }
                ]}
                accessibilityElementsHidden
                importantForAccessibility="no"
              >
                {lineIndex + 1}
              </Text>
              <Text selectable style={styles.sourceLineText}>
                {lineSegments.length > 0 ? (
                  <MobileSyntaxSegments segments={lineSegments} />
                ) : (
                  ' '
                )}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text selectable style={styles.textPreview} accessibilityLabel="File preview">
          <MobileSyntaxSegments segments={syntax.segments} />
        </Text>
      )}
    </ScrollView>
  )
}

export function MobileFilePreviewTruncatedNote({ byteLength }: { byteLength: number }) {
  useMobileColorScheme()
  return (
    <Text style={styles.truncatedNote}>
      Preview truncated. File size: {formatPreviewByteLength(byteLength)}.
    </Text>
  )
}
