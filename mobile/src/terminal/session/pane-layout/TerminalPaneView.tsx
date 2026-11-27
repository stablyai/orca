import type { TerminalFontStyle } from '../../preferences/terminal-font-style'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, StyleSheet, View, Text, Pressable } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import type { ParsedFileLinkLocation } from '../../../../../src/shared/file-links/file-link-location'
import { terminalPaneKeyboardLayout } from './mobile-terminal-pane-layout'
import { spacing, typography, pressedStyle } from '../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../theme/themed-styles'
import type { TerminalFrame, TerminalHostSettings } from '../../webview/terminal-webview-messages'
import { TerminalWebView } from '../../webview/TerminalWebView'
import { MobileNativeChatFloatingControls } from '../../../session/native-chat/lower-region/MobileNativeChatFloatingControls'
import { useKeyboardPersistingTaps } from '../../../platform/keyboard/keyboard-persisting-taps'
import type {
  TerminalKeyboardAvoidanceMetrics,
  TerminalModes,
  TerminalPointerInput,
  TerminalWebViewHandle
} from '../../webview/terminal-webview-contract'
import type { RuntimeMobileTerminalTheme } from '../../../../../src/shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'

const PANE_HEADING_HEIGHT = 44

type TerminalPaneViewProps = {
  handle: string
  active: boolean
  visible?: boolean
  splitIndex?: number
  splitDirection?: 'row' | 'column'
  splitFrame?: TerminalFrame
  keyboardInset?: number
  title?: string
  onFrame?: (handle: string, frame: TerminalFrame) => void
  keyboardLift: number
  terminalTheme?: RuntimeMobileTerminalTheme
  hostSettings?: TerminalHostSettings
  textScale: number
  fontStyle: TerminalFontStyle
  onRef: (handle: string, ref: TerminalWebViewHandle | null) => void
  // Must keep one identity: the pane reports its document gone when it unmounts.
  onDocumentReleased: (handle: string) => void
  onWebReady: (handle: string) => void
  onSelectionMode: (handle: string, active: boolean) => void
  onSelectionCopy: (handle: string, text: string) => void
  onSelectionEvicted: (handle: string) => void
  onClipboardWrite: (handle: string, text: string) => void
  onModesChanged: (handle: string, modes: TerminalModes) => void
  onKeyboardAvoidanceMetrics: (handle: string, metrics: TerminalKeyboardAvoidanceMetrics) => void
  onHaptic: (kind: 'selection' | 'success' | 'error' | 'edge-bump') => void
  onTerminalInput: (handle: string, bytes: string, input?: TerminalPointerInput) => void
  onTerminalQueryReply: (handle: string, bytes: string) => void
  onTerminalInteraction: (handle: string) => void
  onTerminalTap: (handle: string) => void
  onFileTap: (handle: string, candidates: readonly ParsedFileLinkLocation[]) => void
  onOpenUrl: (handle: string, url: string) => void
  onTextScaleChange: (scale: number) => void
  onCellBoxChange: (handle: string) => void
}

export function TerminalPaneView({
  handle,
  active,
  visible = active,
  splitIndex,
  splitDirection = 'row',
  splitFrame,
  keyboardInset = 0,
  title,
  onFrame,
  keyboardLift,
  terminalTheme,
  hostSettings,
  textScale,
  fontStyle,
  onRef,
  onDocumentReleased,
  onWebReady,
  onSelectionMode,
  onSelectionCopy,
  onSelectionEvicted,
  onClipboardWrite,
  onModesChanged,
  onKeyboardAvoidanceMetrics,
  onHaptic,
  onTerminalInput,
  onTerminalQueryReply,
  onTerminalInteraction,
  onTerminalTap,
  onFileTap,
  onOpenUrl,
  onTextScaleChange,
  onCellBoxChange
}: TerminalPaneViewProps) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  useEffect(() => () => onDocumentReleased(handle), [handle, onDocumentReleased])
  const [routeFocused, setRouteFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setRouteFocused(true)
      return () => setRouteFocused(false)
    }, [])
  )
  const [appActive, setAppActive] = useState(() => AppState.currentState === 'active')
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      setAppActive(state === 'active')
    )
    return () => subscription.remove()
  }, [])
  const webViewRef = useRef<TerminalWebViewHandle | null>(null)
  const setRef = useCallback(
    (ref: TerminalWebViewHandle | null) => {
      webViewRef.current = ref
      onRef(handle, ref)
    },
    [handle, onRef]
  )
  // Scrolled back through output: the chat's jump-to-latest button brings the newest lines back.
  const [scrolledUp, setScrolledUp] = useState(false)
  // Jumping must not take focus from the live field, or typing stops reaching the terminal.
  const keepsKeyboard = useKeyboardPersistingTaps('always')

  const [headingHeight, setHeadingHeight] = useState(PANE_HEADING_HEIGHT)
  const splitLayout =
    splitIndex !== undefined && splitFrame && splitFrame.height > 0
      ? terminalPaneKeyboardLayout(splitFrame, splitDirection, splitIndex, keyboardInset)
      : null

  return (
    <View
      // Hidden terminals the session keeps mounted preserve scrollback when the visible pair changes.
      pointerEvents={visible ? 'auto' : 'none'}
      style={[
        styles.terminalPane,
        splitIndex !== undefined &&
          (splitDirection === 'row'
            ? { width: '50%', left: splitIndex === 0 ? '0%' : '50%', right: undefined }
            : { height: '50%', top: splitIndex === 0 ? '0%' : '50%', bottom: undefined }),
        splitLayout && { top: splitLayout.top, height: splitLayout.height, bottom: undefined },
        !visible && styles.terminalPaneHidden
      ]}
    >
      {splitIndex !== undefined && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            active
              ? t('session.terminalPaneView.focusedPane', '{{title}}, focused', {
                  title: title || t('session.terminalPaneView.terminal', 'Terminal')
                })
              : t('session.terminalPaneView.tapToFocusPane', '{{title}}, tap to focus', {
                  title: title || t('session.terminalPaneView.terminal', 'Terminal')
                })
          }
          accessibilityState={{ selected: active }}
          onPress={() => onTerminalTap(handle)}
          style={({ pressed }) => [
            styles.paneHeading,
            active && styles.paneHeadingActive,
            pressed && pressedStyle
          ]}
          onLayout={(event) => setHeadingHeight(event.nativeEvent.layout.height)}
        >
          <Text numberOfLines={1} style={[styles.paneTitle, active && styles.paneTitleActive]}>
            {title || t('session.terminalPaneView.terminal', 'Terminal')}
          </Text>
        </Pressable>
      )}
      <View style={styles.paneViewport}>
        <View
          style={
            splitLayout
              ? { height: Math.max(0, splitLayout.originalHeight - headingHeight) }
              : styles.terminalWebView
          }
          onLayout={(event) => onFrame?.(handle, event.nativeEvent.layout)}
        >
          <TerminalWebView
            ref={setRef}
            style={[
              styles.terminalWebView,
              keyboardLift > 0 && { transform: [{ translateY: -keyboardLift }] }
            ]}
            terminalTheme={terminalTheme}
            hostSettings={hostSettings}
            textScale={textScale}
            fontStyle={fontStyle}
            shownAtMount={visible}
            interactionActive={visible && appActive && routeFocused}
            onWebReady={() => onWebReady(handle)}
            onSelectionMode={(a) => onSelectionMode(handle, a)}
            onSelectionCopy={(t) => onSelectionCopy(handle, t)}
            onSelectionEvicted={() => onSelectionEvicted(handle)}
            onClipboardWrite={(t) => onClipboardWrite(handle, t)}
            onModesChanged={(m) => onModesChanged(handle, m)}
            onKeyboardAvoidanceMetrics={(m) => onKeyboardAvoidanceMetrics(handle, m)}
            onHaptic={onHaptic}
            onTerminalInput={(bytes, input) => onTerminalInput(handle, bytes, input)}
            onTerminalQueryReply={(bytes) => onTerminalQueryReply(handle, bytes)}
            onTerminalInteraction={() => onTerminalInteraction(handle)}
            onTerminalTap={() => onTerminalTap(handle)}
            onFileTap={(candidates) => onFileTap(handle, candidates)}
            onOpenUrl={(url) => onOpenUrl(handle, url)}
            onTextScaleChange={onTextScaleChange}
            onCellBoxChange={() => onCellBoxChange(handle)}
            onScrolledUpChange={setScrolledUp}
          />
        </View>
        {/* A split pane already ends above the keyboard; a full pane sits under the lifted dock. */}
        <View
          ref={keepsKeyboard}
          pointerEvents="box-none"
          style={[styles.jumpLayer, { bottom: splitLayout ? 0 : keyboardInset }]}
        >
          <MobileNativeChatFloatingControls
            showJumpToTail={visible && scrolledUp}
            onJumpToTail={() => webViewRef.current?.scrollToBottom()}
          />
        </View>
      </View>
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  terminalPane: {
    ...StyleSheet.absoluteFill
  },
  paneViewport: { flex: 1, overflow: 'hidden' },
  // A full touch target: tapping a heading is how the other pane takes the keys.
  paneHeading: {
    minHeight: PANE_HEADING_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  paneHeadingActive: { borderBottomColor: colors.textPrimary },
  paneTitle: { color: colors.textSecondary, fontSize: typography.bodySize },
  paneTitleActive: { color: colors.textPrimary, fontWeight: '600' },
  jumpLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0
  },
  terminalPaneHidden: {
    opacity: 0
  },
  terminalWebView: {
    flex: 1
  }
}))
