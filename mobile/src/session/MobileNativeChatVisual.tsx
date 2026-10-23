import { memo, useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, Modal, StyleSheet, View } from 'react-native'
import { Maximize2 } from 'lucide-react-native'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat-visual-directive'
import { useWindowSafeAreaInsets } from '../layout/side-safe-area'
import { Banner } from '../components/ui/Banner'
import { IconButton } from '../components/ui/IconButton'
import { SheetHeader } from '../components/ui/SheetHeader'
import { colors, radii, spacing } from '../theme/mobile-theme'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'
import { MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT } from './mobile-native-chat-visual-host-document'
import { MobileNativeChatVisualFrame } from './MobileNativeChatVisualFrame'
import { useMobileNativeChatVisual } from './use-mobile-native-chat-visual'
import type { MobileNativeChatVisualRender } from './mobile-native-chat-visual-context'

const DEFAULT_TITLE = 'Visualization'

/** The quiet reserved space a visual takes while it loads. */
function MobileNativeChatVisualPlaceholder() {
  return (
    <View style={[styles.frame, styles.placeholder]}>
      <ActivityIndicator size="small" color={colors.textMuted} />
    </View>
  )
}

/** The transcript's visual renderer for a structured chat's source; null without one. */
export function useMobileNativeChatVisualRenderer(
  source: MobileNativeChatVisualSource | null
): MobileNativeChatVisualRender | null {
  return useMemo(
    () =>
      source
        ? (directive) => <MobileNativeChatVisual directive={directive} source={source} />
        : null,
    [source]
  )
}

/** A `::orca-visual{...}` line in a finished assistant reply, rendered from the chat's host. */
export const MobileNativeChatVisual = memo(function MobileNativeChatVisual({
  directive,
  source
}: {
  directive: NativeChatVisualDirective
  source: MobileNativeChatVisualSource
}) {
  const { state, retry } = useMobileNativeChatVisual(source, directive.file)
  // A frame that navigated away or kept crashing; cleared by the reader's retry.
  const [frameFailed, setFrameFailed] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const title = directive.title ?? DEFAULT_TITLE
  const onFrameFailed = useCallback(() => {
    setFrameFailed(true)
    setFullscreen(false)
  }, [])
  const onRetry = useCallback(() => {
    setFrameFailed(false)
    retry()
  }, [retry])
  const closeFullscreen = useCallback(() => setFullscreen(false), [])

  if (state.kind === 'loading') {
    return <MobileNativeChatVisualPlaceholder />
  }
  if (state.kind === 'unavailable' || frameFailed) {
    return (
      <View style={styles.unavailable}>
        <Banner
          message="This visualization couldn't load."
          action={{ label: 'Try again', onPress: onRetry }}
        />
      </View>
    )
  }
  return (
    <View style={styles.frame}>
      <MobileNativeChatVisualFrame
        html={state.html}
        title={title}
        mode="inline"
        onFailed={onFrameFailed}
      />
      <IconButton
        icon={Maximize2}
        accessibilityLabel={`Open ${title} full screen`}
        onPress={() => setFullscreen(true)}
        iconSize={16}
        style={styles.openButton}
      />
      {fullscreen ? (
        <MobileNativeChatVisualFullscreen
          html={state.html}
          title={title}
          onClose={closeFullscreen}
          onFailed={onFrameFailed}
        />
      ) : null}
    </View>
  )
})

function MobileNativeChatVisualFullscreen({
  html,
  title,
  onClose,
  onFailed
}: {
  html: string
  title: string
  onClose: () => void
  onFailed: () => void
}) {
  const insets = useWindowSafeAreaInsets()
  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View
        style={[
          styles.sheet,
          {
            paddingTop: insets.top,
            paddingRight: insets.right,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left
          }
        ]}
      >
        <View style={styles.sheetHeader}>
          <SheetHeader title={title} trailing={{ label: 'Done', onPress: onClose }} />
        </View>
        <MobileNativeChatVisualFrame
          html={html}
          title={title}
          mode="fullscreen"
          onFailed={onFailed}
        />
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  frame: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    borderRadius: radii.card,
    marginBottom: spacing.sm,
    overflow: 'hidden'
  },
  placeholder: {
    height: MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgPanel
  },
  // The banner insets itself for a screen edge; in a message it takes the prose column.
  unavailable: { marginHorizontal: -spacing.lg, marginBottom: spacing.sm },
  openButton: {
    position: 'absolute',
    top: 0,
    right: 0
  },
  sheet: { flex: 1, backgroundColor: colors.bgBase },
  sheetHeader: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator
  }
})
