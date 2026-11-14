import { MobileMarkdownPreviewImage } from './MobileMarkdownPreviewImage'
import type { MobileFilePreviewRpcSender } from '../preview/mobile-file-preview-operations'
import { MobileMarkdown } from '../../components/MobileMarkdown'
import { MOBILE_MARKDOWN_DOCUMENT_SCALE } from '../../components/mobile-markdown-styles'
import { useEffect, useRef, type ComponentRef } from 'react'
import { Platform, ScrollView, View } from 'react-native'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import {
  MobileFilePreviewSourceText,
  MobileFilePreviewTruncatedNote
} from '../preview/MobileFilePreviewSourceText'
import type { MarkdownPreviewMode } from './MobileMarkdownPreviewModeBar'
import { filePreviewStyles as styles } from '../preview/mobile-file-preview-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMarkdownTextScale } from '../../markdown-text-scale/use-markdown-text-scale'
import { useMarkdownTextScalePinchGesture } from '../../markdown-text-scale/use-markdown-text-scale-pinch-gesture'

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
  const scrollRef = useRef<ComponentRef<typeof ScrollView>>(null)
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
    const scroller: unknown = scrollRef.current?.getScrollableNode()
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
        textScale={MOBILE_MARKDOWN_DOCUMENT_SCALE * textScale}
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
