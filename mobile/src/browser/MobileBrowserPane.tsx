import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  AppState,
  Image,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState
} from 'react-native'
import { ArrowUp, ChevronLeft, ChevronRight, RefreshCw, RotateCw } from 'lucide-react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcSuccess } from '../transport/types'
import type {
  BrowserScreencastFrame,
  BrowserScreencastFrameMetadata
} from '../transport/browser-screencast-protocol'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'

export type MobileBrowserTab = {
  type: 'browser'
  id: string
  title: string
  browserWorkspaceId: string
  browserPageId: string | null
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isActive: boolean
}

type MobileBrowserPaneProps = {
  client: RpcClient | null
  worktreeId: string
  tab: MobileBrowserTab
  screencastSupported: boolean | null
  keyboardLift: number
  bottomInset: number
  onToast: (message: string, durationMs?: number) => void
}

type ViewportLayout = {
  width: number
  height: number
}

type BrowserPoint = {
  x: number
  y: number
}

const TAP_SLOP = 10
const LONG_PRESS_MS = 550
const WHEEL_INTERVAL_MS = 70
const BROWSER_FRAME_FORMAT = 'jpeg'

export function MobileBrowserPane({
  client,
  worktreeId,
  tab,
  screencastSupported,
  keyboardLift,
  bottomInset,
  onToast
}: MobileBrowserPaneProps) {
  const [addressValue, setAddressValue] = useState(tab.url || 'about:blank')
  const [addressFocused, setAddressFocused] = useState(false)
  const [keyboardValue, setKeyboardValue] = useState('')
  const [frameUri, setFrameUri] = useState<string | null>(null)
  const [frameMetadata, setFrameMetadata] = useState<BrowserScreencastFrameMetadata | null>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rotated, setRotated] = useState(false)
  const [layout, setLayout] = useState<ViewportLayout | null>(null)
  const [appActive, setAppActive] = useState(AppState.currentState === 'active')
  const streamGenerationRef = useRef(0)
  const layoutRef = useRef<ViewportLayout | null>(null)
  const frameMetadataRef = useRef<BrowserScreencastFrameMetadata | null>(null)
  const rotatedRef = useRef(false)
  const startPointRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rightClickSentRef = useRef(false)
  const lastWheelRef = useRef<{ dx: number; dy: number; at: number }>({ dx: 0, dy: 0, at: 0 })

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      setAppActive(nextState === 'active')
    })
    return () => {
      subscription.remove()
    }
  }, [])

  useEffect(() => {
    if (!addressFocused) {
      setAddressValue(tab.url || 'about:blank')
    }
  }, [addressFocused, tab.url])

  useEffect(() => {
    frameMetadataRef.current = frameMetadata
  }, [frameMetadata])

  useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  useEffect(() => {
    rotatedRef.current = rotated
  }, [rotated])

  const pageParams = useCallback(() => {
    if (!tab.browserPageId) {
      return null
    }
    return {
      worktree: `id:${worktreeId}`,
      page: tab.browserPageId
    }
  }, [tab.browserPageId, worktreeId])

  const applyFrame = useCallback((frame: BrowserScreencastFrame): void => {
    setFrameMetadata(frame.metadata)
    setFrameUri(`data:image/${frame.format};base64,${bytesToBase64(frame.image)}`)
    setBusy(false)
    setReady(true)
  }, [])

  useEffect(() => {
    streamGenerationRef.current += 1
    const generation = streamGenerationRef.current
    setFrameUri(null)
    setFrameMetadata(null)
    setReady(false)
    setError(null)
    if (!client || screencastSupported !== true || !tab.browserPageId || !appActive) {
      setBusy(false)
      if (screencastSupported === false) {
        setError('Update desktop Orca to stream browser tabs on mobile.')
      } else if (screencastSupported === null) {
        setError('Checking desktop browser streaming support.')
      } else if (!tab.browserPageId) {
        setError('Browser page is not available yet.')
      }
      return
    }
    setBusy(true)
    let startupTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (streamGenerationRef.current !== generation) return
      setBusy(false)
      setError('Browser stream timed out.')
    }, 15_000)
    const clearStartupTimer = (): void => {
      if (startupTimer) {
        clearTimeout(startupTimer)
        startupTimer = null
      }
    }
    const unsubscribe = client.subscribe(
      'browser.screencast',
      {
        worktree: `id:${worktreeId}`,
        page: tab.browserPageId,
        format: BROWSER_FRAME_FORMAT,
        quality: 64,
        maxWidth: rotated ? 1200 : 900,
        maxHeight: rotated ? 900 : 1400,
        everyNthFrame: 2
      },
      (payload) => {
        if (streamGenerationRef.current !== generation) return
        const event = payload as {
          type?: string
          message?: string
          error?: { message?: string }
          tab?: { url?: string; title?: string; canGoBack?: boolean; canGoForward?: boolean }
        }
        if (event.type === 'ready') {
          clearStartupTimer()
          setReady(true)
          setBusy(false)
          if (typeof event.tab?.url === 'string') {
            setAddressValue(event.tab.url)
          }
        } else if (event.type === 'end') {
          clearStartupTimer()
          setReady(false)
          setBusy(false)
        } else if (event.type === 'error') {
          clearStartupTimer()
          setReady(false)
          setBusy(false)
          setError(event.message ?? event.error?.message ?? 'Browser stream failed.')
        }
      },
      {
        onBinaryFrame: (frame) => {
          if (streamGenerationRef.current !== generation) return
          clearStartupTimer()
          applyFrame(frame)
        }
      }
    )
    return () => {
      clearStartupTimer()
      unsubscribe()
    }
  }, [appActive, applyFrame, client, rotated, screencastSupported, tab.browserPageId, worktreeId])

  const sendBrowserRequest = useCallback(
    async (
      method: string,
      params: Record<string, unknown> = {},
      opts: { showBusy?: boolean; timeoutMs?: number } = {}
    ): Promise<unknown | null> => {
      const base = pageParams()
      if (!client || !base) {
        return null
      }
      if (opts.showBusy) {
        setBusy(true)
      }
      try {
        const response = await client.sendRequest(
          method,
          { ...base, ...params },
          { timeoutMs: opts.timeoutMs ?? 15_000 }
        )
        if (!response.ok) {
          throw new Error((response as RpcFailure).error.message)
        }
        setError(null)
        return (response as RpcSuccess).result
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Browser command failed'
        setError(message)
        return null
      } finally {
        if (opts.showBusy) {
          setBusy(false)
        }
      }
    },
    [client, pageParams]
  )

  const navigateToAddress = useCallback(async () => {
    const url = normalizeMobileBrowserUrl(addressValue)
    if (!url) {
      setError('Enter a valid URL.')
      return
    }
    const result = (await sendBrowserRequest(
      'browser.goto',
      { url },
      { showBusy: true, timeoutMs: 30_000 }
    )) as { url?: string } | null
    if (typeof result?.url === 'string') {
      setAddressValue(result.url)
    }
  }, [addressValue, sendBrowserRequest])

  const sendPointerClick = useCallback(
    async (point: BrowserPoint, button: 'left' | 'right') => {
      const base = pageParams()
      if (!client || !base) {
        return
      }
      try {
        assertRpcOk(
          await client.sendRequest('browser.mouseMove', { ...base, x: point.x, y: point.y }),
          'Browser pointer move failed'
        )
        assertRpcOk(
          await client.sendRequest('browser.mouseDown', { ...base, button }),
          'Browser pointer down failed'
        )
        assertRpcOk(
          await client.sendRequest('browser.mouseUp', { ...base, button }),
          'Browser pointer up failed'
        )
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Browser click failed')
      }
    },
    [client, pageParams]
  )

  const sendWheel = useCallback(
    (point: BrowserPoint, screenDx: number, screenDy: number) => {
      const base = pageParams()
      if (!client || !base) {
        return
      }
      const delta = rotatedRef.current
        ? { dx: Math.round(-screenDy), dy: Math.round(screenDx) }
        : { dx: Math.round(-screenDx), dy: Math.round(-screenDy) }
      if (Math.abs(delta.dx) < 1 && Math.abs(delta.dy) < 1) {
        return
      }
      void (async () => {
        try {
          assertRpcOk(
            await client.sendRequest('browser.mouseMove', { ...base, x: point.x, y: point.y }),
            'Browser pointer move failed'
          )
          assertRpcOk(
            await client.sendRequest('browser.mouseWheel', { ...base, dx: delta.dx, dy: delta.dy }),
            'Browser scroll failed'
          )
          setError(null)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Browser scroll failed')
        }
      })()
    },
    [client, pageParams]
  )

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  useEffect(() => () => clearLongPressTimer(), [clearLongPressTimer])

  const mapTouchPoint = useCallback((locationX: number, locationY: number): BrowserPoint | null => {
    const currentLayout = layoutRef.current
    const metadata = frameMetadataRef.current
    if (!currentLayout || currentLayout.width <= 0 || currentLayout.height <= 0) {
      return null
    }
    const viewportWidth = getPositiveFiniteNumber(metadata?.deviceWidth) ?? currentLayout.width
    const viewportHeight = getPositiveFiniteNumber(metadata?.deviceHeight) ?? currentLayout.height
    if (rotatedRef.current) {
      return {
        x: clamp(Math.round((locationY / currentLayout.height) * viewportWidth), 0, viewportWidth),
        y: clamp(
          Math.round(((currentLayout.width - locationX) / currentLayout.width) * viewportHeight),
          0,
          viewportHeight
        )
      }
    }
    return {
      x: clamp(Math.round((locationX / currentLayout.width) * viewportWidth), 0, viewportWidth),
      y: clamp(Math.round((locationY / currentLayout.height) * viewportHeight), 0, viewportHeight)
    }
  }, [])

  const handleResponderGrant = useCallback(
    (event: GestureResponderEvent) => {
      const { locationX, locationY } = event.nativeEvent
      startPointRef.current = { x: locationX, y: locationY, t: Date.now() }
      rightClickSentRef.current = false
      lastWheelRef.current = { dx: 0, dy: 0, at: 0 }
      clearLongPressTimer()
      longPressTimerRef.current = setTimeout(() => {
        const start = startPointRef.current
        if (!start) return
        const point = mapTouchPoint(start.x, start.y)
        if (!point) return
        rightClickSentRef.current = true
        void sendPointerClick(point, 'right')
        onToast('Right click')
      }, LONG_PRESS_MS)
    },
    [clearLongPressTimer, mapTouchPoint, onToast, sendPointerClick]
  )

  const handleResponderMove = useCallback(
    (event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      if (Math.abs(gesture.dx) > TAP_SLOP || Math.abs(gesture.dy) > TAP_SLOP) {
        clearLongPressTimer()
      }
      const now = Date.now()
      if (now - lastWheelRef.current.at < WHEEL_INTERVAL_MS) {
        return
      }
      const deltaX = gesture.dx - lastWheelRef.current.dx
      const deltaY = gesture.dy - lastWheelRef.current.dy
      if (Math.abs(deltaX) + Math.abs(deltaY) < 8) {
        return
      }
      const point = mapTouchPoint(event.nativeEvent.locationX, event.nativeEvent.locationY)
      if (!point) {
        return
      }
      lastWheelRef.current = { dx: gesture.dx, dy: gesture.dy, at: now }
      sendWheel(point, deltaX, deltaY)
    },
    [clearLongPressTimer, mapTouchPoint, sendWheel]
  )

  const handleResponderRelease = useCallback(
    (event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      clearLongPressTimer()
      const start = startPointRef.current
      startPointRef.current = null
      if (!start || rightClickSentRef.current) {
        return
      }
      const moved = Math.hypot(gesture.dx, gesture.dy)
      if (moved <= TAP_SLOP && Date.now() - start.t < LONG_PRESS_MS) {
        const point = mapTouchPoint(event.nativeEvent.locationX, event.nativeEvent.locationY)
        if (point) {
          void sendPointerClick(point, 'left')
        }
      }
    },
    [clearLongPressTimer, mapTouchPoint, sendPointerClick]
  )

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: handleResponderGrant,
        onPanResponderMove: handleResponderMove,
        onPanResponderRelease: handleResponderRelease,
        onPanResponderTerminate: () => {
          clearLongPressTimer()
          startPointRef.current = null
        },
        onPanResponderTerminationRequest: () => true
      }),
    [clearLongPressTimer, handleResponderGrant, handleResponderMove, handleResponderRelease]
  )

  const sendKeyboardText = useCallback(async () => {
    const text = keyboardValue
    if (!text) {
      return
    }
    setKeyboardValue('')
    const result = await sendBrowserRequest('browser.keyboardInsertText', { text })
    if (result !== null) {
      onToast('Sent')
    } else {
      setKeyboardValue(text)
    }
  }, [keyboardValue, onToast, sendBrowserRequest])

  const sendKeypress = useCallback(
    async (key: string) => {
      await sendBrowserRequest('browser.keypress', { key })
    },
    [sendBrowserRequest]
  )

  const rotatedImageStyle =
    rotated && layout
      ? {
          width: layout.height,
          height: layout.width,
          transform: [{ rotate: '90deg' }]
        }
      : styles.browserImageFill

  const controlsDisabled = !client || !tab.browserPageId || screencastSupported !== true

  return (
    <View style={styles.root}>
      <View style={styles.toolbar}>
        <IconButton
          disabled={controlsDisabled || !tab.canGoBack}
          label="Back"
          onPress={() => void sendBrowserRequest('browser.back', {}, { showBusy: true })}
        >
          <ChevronLeft size={17} color={buttonColor(!controlsDisabled && tab.canGoBack)} />
        </IconButton>
        <IconButton
          disabled={controlsDisabled || !tab.canGoForward}
          label="Forward"
          onPress={() => void sendBrowserRequest('browser.forward', {}, { showBusy: true })}
        >
          <ChevronRight size={17} color={buttonColor(!controlsDisabled && tab.canGoForward)} />
        </IconButton>
        <IconButton
          disabled={controlsDisabled}
          label="Reload"
          onPress={() => void sendBrowserRequest('browser.reload', {}, { showBusy: true })}
        >
          <RefreshCw size={16} color={buttonColor(!controlsDisabled)} />
        </IconButton>
        <TextInput
          style={styles.addressInput}
          value={addressValue}
          onChangeText={setAddressValue}
          onFocus={() => setAddressFocused(true)}
          onBlur={() => setAddressFocused(false)}
          onSubmitEditing={() => void navigateToAddress()}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
          returnKeyType="go"
          placeholder="URL"
          placeholderTextColor={colors.textMuted}
          editable={!controlsDisabled}
        />
        <IconButton
          disabled={controlsDisabled}
          label="Rotate browser"
          selected={rotated}
          onPress={() => setRotated((value) => !value)}
        >
          <RotateCw size={16} color={buttonColor(!controlsDisabled)} />
        </IconButton>
      </View>

      <View
        style={styles.viewport}
        onLayout={(event) => {
          const next = {
            width: event.nativeEvent.layout.width,
            height: event.nativeEvent.layout.height
          }
          layoutRef.current = next
          setLayout(next)
        }}
        {...panResponder.panHandlers}
      >
        {frameUri ? (
          <View style={styles.browserImageHost}>
            <Image source={{ uri: frameUri }} resizeMode="stretch" style={rotatedImageStyle} />
          </View>
        ) : null}
        {!frameUri || busy || error ? (
          <View pointerEvents="none" style={styles.overlay}>
            {busy || (!ready && !error) ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : null}
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </View>
        ) : null}
      </View>

      <View
        style={[
          styles.keyboardDock,
          { paddingBottom: bottomInset, transform: [{ translateY: -keyboardLift }] }
        ]}
      >
        <View style={styles.keyRow}>
          {['Enter', 'Backspace', 'Tab', 'Escape'].map((key) => (
            <Pressable
              key={key}
              style={({ pressed }) => [
                styles.keyButton,
                pressed && styles.keyButtonPressed,
                controlsDisabled && styles.disabled
              ]}
              disabled={controlsDisabled}
              onPress={() => void sendKeypress(key)}
            >
              <Text style={[styles.keyButtonText, controlsDisabled && styles.disabledText]}>
                {key === 'Backspace' ? '⌫' : key === 'Escape' ? 'Esc' : key}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.inputRow}>
          <TextInput
            style={styles.keyboardInput}
            value={keyboardValue}
            onChangeText={setKeyboardValue}
            placeholder="Type on page…"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!controlsDisabled}
            onSubmitEditing={() => void sendKeyboardText()}
          />
          <Pressable
            style={[styles.sendButton, (controlsDisabled || !keyboardValue) && styles.disabled]}
            disabled={controlsDisabled || !keyboardValue}
            onPress={() => void sendKeyboardText()}
            accessibilityLabel="Send text to browser"
          >
            <ArrowUp size={18} color={buttonColor(!controlsDisabled && !!keyboardValue)} />
          </Pressable>
        </View>
      </View>
    </View>
  )
}

function IconButton({
  children,
  disabled,
  label,
  onPress,
  selected
}: {
  children: ReactNode
  disabled?: boolean
  label: string
  onPress: () => void
  selected?: boolean
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.iconButton,
        selected && styles.iconButtonSelected,
        pressed && styles.iconButtonPressed,
        disabled && styles.disabled
      ]}
      disabled={disabled}
      onPress={onPress}
      accessibilityLabel={label}
    >
      {children}
    </Pressable>
  )
}

function buttonColor(enabled: boolean): string {
  return enabled ? colors.textSecondary : colors.textMuted
}

function assertRpcOk(
  response: RpcSuccess | RpcFailure,
  fallbackMessage: string
): asserts response is RpcSuccess {
  if (!response.ok) {
    throw new Error(response.error.message || fallbackMessage)
  }
}

function normalizeMobileBrowserUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'about:blank') {
    return 'about:blank'
  }
  try {
    const parsed = new URL(trimmed)
    return parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'file:'
      ? parsed.toString()
      : null
  } catch {
    try {
      return new URL(`https://${trimmed}`).toString()
    } catch {
      return null
    }
  }
}

function getPositiveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let result = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c
    result += chars[(triple >> 18) & 63]
    result += chars[(triple >> 12) & 63]
    result += i + 1 < bytes.length ? chars[(triple >> 6) & 63] : '='
    result += i + 2 < bytes.length ? chars[triple & 63] : '='
  }
  return result
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: colors.bgBase
  },
  toolbar: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: radii.button,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  iconButtonSelected: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  addressInput: {
    flex: 1,
    minWidth: 0,
    height: 32,
    borderRadius: radii.input,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    paddingHorizontal: spacing.sm,
    fontSize: 13,
    fontFamily: typography.monoFamily
  },
  viewport: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    backgroundColor: colors.bgBase
  },
  browserImageHost: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  browserImageFill: {
    width: '100%',
    height: '100%'
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
    backgroundColor: 'rgba(13, 15, 24, 0.2)'
  },
  errorText: {
    color: colors.textPrimary,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.button,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 13,
    textAlign: 'center',
    overflow: 'hidden'
  },
  keyboardDock: {
    zIndex: 20,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  keyRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs
  },
  keyButton: {
    minHeight: 30,
    minWidth: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm
  },
  keyButtonPressed: {
    backgroundColor: colors.borderSubtle
  },
  keyButtonText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: typography.monoFamily
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xs + 2
  },
  keyboardInput: {
    flex: 1,
    height: 34,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    fontSize: 14,
    fontFamily: typography.monoFamily,
    marginRight: spacing.sm
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  disabled: {
    opacity: 0.35
  },
  disabledText: {
    color: colors.textMuted
  }
})
