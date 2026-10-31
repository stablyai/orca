import { useCallback, useEffect, useState } from 'react'
import { AppState, StyleSheet, View, Text, Pressable } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ParsedFileLinkLocation } from '../../../src/shared/file-link-location'
import { terminalPaneKeyboardLayout } from './mobile-terminal-pane-layout'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { TerminalFrame } from '../terminal/terminal-webview-messages'
import { TerminalWebView } from '../terminal/TerminalWebView'
import type {
  MobileTerminalTheme,
  TerminalKeyboardAvoidanceMetrics,
  TerminalModes,
  TerminalPointerInput,
  TerminalWebViewHandle
} from '../terminal/terminal-webview-contract'

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
  terminalTheme?: MobileTerminalTheme
  textScale: number
  onRef: (handle: string, ref: TerminalWebViewHandle | null) => void
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
  textScale,
  onRef,
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
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [visited, setVisited] = useState(visible)
  if (visible && !visited) {
    setVisited(true)
  }
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
  const setRef = useCallback(
    (ref: TerminalWebViewHandle | null) => {
      onRef(handle, ref)
    },
    [handle, onRef]
  )

  const [headingHeight, setHeadingHeight] = useState(28)
  const splitLayout =
    splitIndex !== undefined && splitFrame && splitFrame.height > 0
      ? terminalPaneKeyboardLayout(splitFrame, splitDirection, splitIndex, keyboardInset)
      : null

  if (!visible && !visited) {
    return null
  }

  return (
    <View
      // Hidden terminals stay mounted so changing the visible pair preserves scrollback.
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
          style={[styles.paneHeading, active && styles.paneHeadingActive]}
          onLayout={(event) => setHeadingHeight(event.nativeEvent.layout.height)}
        >
          <Text numberOfLines={1} style={styles.paneTitle}>
            {active
              ? t('session.terminalPaneView.inputPane', '{{title}} · Input', {
                  title: title || t('session.terminalPaneView.terminal', 'Terminal')
                })
              : title || t('session.terminalPaneView.terminal', 'Terminal')}
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
            textScale={textScale}
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
          />
        </View>
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  terminalPane: {
    ...StyleSheet.absoluteFillObject
  },
  paneViewport: { flex: 1, overflow: 'hidden' },
  paneHeading: {
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  paneHeadingActive: { borderBottomColor: colors.textPrimary },
  paneTitle: { color: colors.textSecondary, fontSize: 12 },
  terminalPaneHidden: {
    opacity: 0
  },
  terminalWebView: {
    flex: 1
  }
}))
