import { MobileMarkdownPreviewImage } from './MobileMarkdownPreviewImage'
import type { MobileFilePreviewRpcSender } from './mobile-file-preview-operations'
import { useEffect, useRef, useState } from 'react'
import { Platform, Pressable, ScrollView, View } from 'react-native'
import { Code, Pencil } from 'lucide-react-native'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { MobileSourceCopyButton } from '../components/MobileSourceCopyButton'
import { MarkdownTextSizeButton } from '../markdown-text-scale/MarkdownTextSizeButton'
import { useMarkdownTextScale } from '../markdown-text-scale/use-markdown-text-scale'
import { useMarkdownTextScalePinchGesture } from '../markdown-text-scale/use-markdown-text-scale-pinch-gesture'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  MobileFilePreviewSourceText,
  MobileFilePreviewTruncatedNote
} from './MobileFilePreviewSourceText'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

type Props = {
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
  const t = useMobileTranslation()
  const [mode, setMode] = useState<'preview' | 'source'>(() => (initialLine ? 'source' : 'preview'))
  const [previousRelativePath, setPreviousRelativePath] = useState(relativePath)
  const [previousInitialLine, setPreviousInitialLine] = useState(initialLine)
  // Switch modes before paint for a new file or line target; do not flash the previous manual mode.
  if (relativePath !== previousRelativePath || initialLine !== previousInitialLine) {
    setPreviousRelativePath(relativePath)
    setPreviousInitialLine(initialLine)
    setMode(initialLine ? 'source' : 'preview')
  }
  const previewSelected = mode === 'preview'
  const sourceSelected = mode === 'source'
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
  }, [previewSelected])

  const preview = (
    <ScrollView
      ref={scrollRef}
      style={styles.scroll}
      contentContainerStyle={styles.markdownContent}
    >
      {truncated ? <MobileFilePreviewTruncatedNote byteLength={byteLength} /> : null}
      <MobileMarkdown
        content={content}
        textScale={textScale}
        scaleListMarkers
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
    <View style={styles.modeContainer}>
      <View style={styles.modeToolbar}>
        <Pressable
          style={[styles.modeToggle, sourceSelected && styles.modeToggleActive]}
          onPress={() => setMode('source')}
          accessibilityRole="button"
          accessibilityState={{ selected: sourceSelected }}
          accessibilityLabel={t('files.fileMarkdownPreview.viewSource', 'View Markdown source')}
        >
          <Code
            size={15}
            color={sourceSelected ? colors.textPrimary : colors.textSecondary}
            strokeWidth={2.2}
          />
        </Pressable>
        <Pressable
          style={[styles.modeToggle, previewSelected && styles.modeToggleActive]}
          onPress={() => setMode('preview')}
          accessibilityRole="button"
          accessibilityState={{ selected: previewSelected }}
          accessibilityLabel={t(
            'files.fileMarkdownPreview.viewPreview',
            'View rendered Markdown preview'
          )}
        >
          <Pencil
            size={15}
            color={previewSelected ? colors.textPrimary : colors.textSecondary}
            strokeWidth={2.2}
          />
        </Pressable>
        {previewSelected ? (
          <MarkdownTextSizeButton textScale={textScale} onSelect={commitTextScale} />
        ) : null}
        <MobileSourceCopyButton
          key={relativePath}
          text={content}
          partial={truncated}
          accessibilityLabel={
            truncated
              ? t('files.fileMarkdownPreview.copyLoadedSource', 'Copy loaded Markdown source')
              : t('files.fileMarkdownPreview.copySource', 'Copy Markdown source')
          }
        />
      </View>
      {mode === 'preview' ? (
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
      ) : (
        <MobileFilePreviewSourceText
          relativePath={relativePath}
          content={content}
          truncated={truncated}
          byteLength={byteLength}
          initialLine={initialLine}
        />
      )}
    </View>
  )
}
