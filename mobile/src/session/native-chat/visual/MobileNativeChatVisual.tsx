import { memo, useCallback, useMemo, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { Maximize2, X } from 'lucide-react-native'
import type { NativeChatVisualDirective } from '../../../../../src/shared/native-chat/native-chat-visual-directive'
import { useWindowSafeAreaInsets } from '../../../layout/side-safe-area'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import type { MobileNativeChatVisualSource } from './mobile-native-chat-visual-read'
import { MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT } from './mobile-native-chat-visual-host-document'
import { MobileNativeChatVisualFrame } from './MobileNativeChatVisualFrame'
import { useMobileNativeChatVisual } from './use-mobile-native-chat-visual'
import type { MobileNativeChatVisualRender } from './mobile-native-chat-visual-context'

const DEFAULT_TITLE = 'Visualization'

function MobileNativeChatVisualPlaceholder() {
  useMobileColorScheme()
  return (
    <View style={[styles.frame, styles.placeholder]}>
      <ActivityIndicator size="small" color={colors.textMuted} />
    </View>
  )
}

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

export const MobileNativeChatVisual = memo(function MobileNativeChatVisual({
  directive,
  source
}: {
  directive: NativeChatVisualDirective
  source: MobileNativeChatVisualSource
}) {
  useMobileColorScheme()
  const { state, retry } = useMobileNativeChatVisual(source, directive.file)
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
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Visualization unavailable"
        accessibilityHint="Tries to load it again"
        style={styles.unavailable}
      >
        <Text style={styles.unavailableText}>Visualization unavailable</Text>
      </Pressable>
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
      <Pressable
        onPress={() => setFullscreen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${title} full screen`}
        hitSlop={8}
        style={styles.openButton}
      >
        <Maximize2 size={14} color={colors.textSecondary} strokeWidth={2.2} />
      </Pressable>
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
  useMobileColorScheme()
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
          <Text style={styles.sheetTitle} numberOfLines={1}>
            {title}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={8}
            style={styles.closeButton}
          >
            <X size={18} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>
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

const styles = themedStyleSheet(() => ({
  frame: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    marginBottom: spacing.sm,
    overflow: 'hidden'
  },
  placeholder: {
    height: MOBILE_NATIVE_CHAT_VISUAL_INITIAL_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center'
  },
  unavailable: { marginBottom: spacing.sm, paddingVertical: spacing.xs },
  unavailableText: { color: colors.textMuted, fontSize: typography.metaSize },
  openButton: {
    position: 'absolute',
    top: spacing.xs,
    right: spacing.xs,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  sheet: { flex: 1, backgroundColor: colors.bgBase },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  sheetTitle: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  closeButton: { padding: spacing.xs }
}))
