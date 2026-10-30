import { useEffect, useMemo, useRef } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { MobileSyntaxSegments } from '../components/MobileSyntaxSegments'
import type { MobileSyntaxSegment } from '../session/mobile-file-syntax'
import { formatPreviewByteLength } from './mobile-file-preview-request'
import { estimateScrollOffsetForLine } from './mobile-file-preview-line-column'
import { buildMobileFilePreviewSyntax } from './mobile-file-preview-syntax'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

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
  const t = useMobileTranslation()
  const scrollRef = useRef<ScrollView>(null)
  const contentHeightRef = useRef(0)
  const layoutHeightRef = useRef(0)
  const revealedKeyRef = useRef<string | null>(null)
  const restoredRatioRef = useRef(false)
  const hasUserScrolledRef = useRef(false)
  const measuredTargetYRef = useRef<number | null>(null)
  const containerTopRef = useRef(16)
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

  const shouldRenderLineRows = showLineNumbers || Boolean(initialLine)

  const lines = useMemo(
    () => (shouldRenderLineRows ? splitSyntaxSegmentsIntoLines(syntax.segments) : null),
    [shouldRenderLineRows, syntax.segments]
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

  useEffect(() => {
    revealedKeyRef.current = null
    hasUserScrolledRef.current = false
    measuredTargetYRef.current = null
    if (contentHeightRef.current > 0) {
      revealInitialLine(contentHeightRef.current)
    }
  }, [revealTargetKey])

  const handleTargetLineLayout = (rowY: number) => {
    measuredTargetYRef.current = rowY
    if (!scrollRef.current || hasUserScrolledRef.current || !revealTargetKey) {
      return
    }
    const targetY = initialLine && initialLine > 1 ? rowY : 0
    scrollRef.current.scrollTo({
      y: Math.max(0, targetY),
      animated: false
    })
    revealedKeyRef.current = revealTargetKey
  }

  const revealInitialLine = (height?: number) => {
    if (
      !initialLine ||
      !revealTargetKey ||
      revealedKeyRef.current === revealTargetKey ||
      !scrollRef.current ||
      hasUserScrolledRef.current
    ) {
      return
    }
    const targetY =
      measuredTargetYRef.current !== null
        ? initialLine > 1
          ? measuredTargetYRef.current
          : 0
        : estimateScrollOffsetForLine(lines, initialLine)

    scrollRef.current.scrollTo({
      y: Math.max(0, targetY),
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
      contentContainerStyle={showLineNumbers ? styles.textContentWithLines : styles.textContent}
      onScrollBeginDrag={() => {
        hasUserScrolledRef.current = true
      }}
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
      {lines ? (
        <View
          style={styles.sourceLinesContainer}
          accessibilityLabel={t('files.filePreviewSourceText.previewLabel', 'File preview')}
          onLayout={(event) => {
            containerTopRef.current = event.nativeEvent.layout.y
          }}
        >
          {lines.map((lineSegments, lineIndex) => {
            const isTargetLine = initialLine !== undefined && lineIndex === initialLine - 1
            return (
              <View
                key={lineIndex}
                style={[styles.sourceLineRow, isTargetLine && styles.sourceLineRowTarget]}
                onLayout={
                  isTargetLine
                    ? (event) => {
                        handleTargetLineLayout(event.nativeEvent.layout.y)
                      }
                    : undefined
                }
              >
                {showLineNumbers ? (
                  <Text
                    style={[
                      styles.sourceLineNumber,
                      { width: lineNumberWidth, minWidth: lineNumberWidth, flexShrink: 0 },
                      isTargetLine && styles.sourceLineNumberTarget
                    ]}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  >
                    {lineIndex + 1}
                  </Text>
                ) : null}
                <Text selectable style={styles.sourceLineText}>
                  {lineSegments.length > 0 ? <MobileSyntaxSegments segments={lineSegments} /> : ' '}
                </Text>
              </View>
            )
          })}
        </View>
      ) : (
        <Text
          selectable
          style={styles.textPreview}
          accessibilityLabel={t('files.filePreviewSourceText.previewLabel', 'File preview')}
        >
          <MobileSyntaxSegments segments={syntax.segments} />
        </Text>
      )}
    </ScrollView>
  )
}

export function MobileFilePreviewTruncatedNote({ byteLength }: { byteLength: number }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <Text style={styles.truncatedNote}>
      {t('files.filePreviewSourceText.truncatedNote', 'Preview truncated. File size: {{size}}.', {
        size: formatPreviewByteLength(byteLength)
      })}
    </Text>
  )
}
