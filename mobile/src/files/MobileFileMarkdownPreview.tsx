import { useState } from 'react'
import { Pressable, ScrollView, View } from 'react-native'
import { Code, Pencil } from 'lucide-react-native'
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import { MobileMarkdown } from '../components/MobileMarkdown'
import { colors } from '../theme/mobile-theme'
import { useMobileNativeChatPinchGesture } from '../session/use-mobile-native-chat-pinch-gesture'
import {
  MobileFilePreviewSourceText,
  MobileFilePreviewTruncatedNote
} from './MobileFilePreviewSourceText'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

type Props = {
  relativePath: string
  content: string
  truncated: boolean
  byteLength: number
  initialLine?: number
  imageSources?: Record<string, string>
  onOpenImage?: (rawSrc: string) => void
}

export function MobileFileMarkdownPreview({
  relativePath,
  content,
  truncated,
  byteLength,
  initialLine,
  imageSources,
  onOpenImage
}: Props) {
  const [mode, setMode] = useState<'preview' | 'source'>(() => (initialLine ? 'source' : 'preview'))
  const [previousRelativePath, setPreviousRelativePath] = useState(relativePath)
  const [previousInitialLine, setPreviousInitialLine] = useState(initialLine)
  // Why: opening a different file or line target must switch modes before paint,
  // never briefly retain the prior file's manually selected mode.
  if (relativePath !== previousRelativePath || initialLine !== previousInitialLine) {
    setPreviousRelativePath(relativePath)
    setPreviousInitialLine(initialLine)
    setMode(initialLine ? 'source' : 'preview')
  }
  const previewSelected = mode === 'preview'
  const sourceSelected = mode === 'source'
  // Same pinch-to-zoom font as the native chat, so a previewed document reads
  // at the size the session editor scales to.
  const { fontScale, pinchGesture } = useMobileNativeChatPinchGesture()

  return (
    <View style={styles.modeContainer}>
      <View style={styles.modeToolbar}>
        <Pressable
          style={[styles.modeToggle, sourceSelected && styles.modeToggleActive]}
          onPress={() => setMode('source')}
          accessibilityRole="button"
          accessibilityState={{ selected: sourceSelected }}
          accessibilityLabel="View Markdown source"
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
          accessibilityLabel="View rendered Markdown preview"
        >
          <Pencil
            size={15}
            color={previewSelected ? colors.textPrimary : colors.textSecondary}
            strokeWidth={2.2}
          />
        </Pressable>
      </View>
      <GestureHandlerRootView style={styles.previewGestureArea}>
        <GestureDetector gesture={pinchGesture}>
          {mode === 'preview' ? (
            <ScrollView style={styles.scroll} contentContainerStyle={styles.markdownContent}>
              {truncated ? <MobileFilePreviewTruncatedNote byteLength={byteLength} /> : null}
              <MobileMarkdown
                content={content}
                imageSources={imageSources}
                onOpenImage={onOpenImage}
                textScale={fontScale}
              />
            </ScrollView>
          ) : (
            <MobileFilePreviewSourceText
              relativePath={relativePath}
              content={content}
              truncated={truncated}
              byteLength={byteLength}
              initialLine={initialLine}
              fontScale={fontScale}
            />
          )}
        </GestureDetector>
      </GestureHandlerRootView>
    </View>
  )
}
