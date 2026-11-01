import { MobileMarkdownPreviewImage } from './MobileMarkdownPreviewImage'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { useEffect, useRef } from 'react'
import { Platform, ScrollView, View } from 'react-native'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { MobileMarkdown } from '../components/MobileMarkdown'
import {
  MobileFilePreviewSourceText,
  MobileFilePreviewTruncatedNote
} from './MobileFilePreviewSourceText'
import type { MarkdownPreviewMode } from './MobileMarkdownPreviewModeBar'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { useMarkdownTextScale } from '../markdown-text-scale/use-markdown-text-scale'
import { useMarkdownTextScalePinchGesture } from '../markdown-text-scale/use-markdown-text-scale-pinch-gesture'
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
  const scrollRef = useRef<ScrollView>(null)
  const { textScale, setLiveScale, commitTextScale } = useMarkdownTextScale()
  const pinchGesture = useMarkdownTextScalePinchGesture({
    textScale,
    onLiveScale: setLiveScale,
    onCommit: commitTextScale,
    combineWithNativeScroll: true
  })

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return
    }
    const scroller = scrollRef.current?.getScrollableNode()
    if (scroller instanceof HTMLElement) {
      scroller.style.touchAction = 'pan-x pan-y'
    }
  }, [mode])

  if (mode !== 'preview') {
    return (
      <MobileFilePreviewSourceText
        relativePath={relativePath}
        content={content}
        truncated={truncated}
        byteLength={byteLength}
        initialLine={initialLine}
      />
    )
  }

  const preview = (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.markdownContent}
    >
      {truncated ? <MobileFilePreviewTruncatedNote byteLength={byteLength} /> : null}
      <MobileMarkdown
        content={content}
        textScale={DOCUMENT_TEXT_SCALE * textScale}
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
  )

  return (
    <GestureHandlerRootView style={styles.scroll}>
      <GestureDetector
        gesture={pinchGesture}
        touchAction="pan-y"
        userSelect="auto"
        enableContextMenu
      >
        {Platform.OS === 'web' ? <View style={styles.scroll}>{preview}</View> : preview}
      </GestureDetector>
    </GestureHandlerRootView>
  )
}
