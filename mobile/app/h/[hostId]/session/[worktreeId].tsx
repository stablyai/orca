import { useState, useEffect, useRef, useCallback } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  Keyboard,
  Platform,
  ActivityIndicator,
  type KeyboardEvent
} from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { ArrowUp, ChevronLeft, Monitor, Plus, Smartphone } from 'lucide-react-native'
import type { RpcClient } from '../../../../src/transport/rpc-client'
import { loadHosts } from '../../../../src/transport/host-store'
import { useHostClient } from '../../../../src/transport/client-context'
import type { ConnectionState, RpcSuccess } from '../../../../src/transport/types'
import { triggerMediumImpact } from '../../../../src/platform/haptics'
import {
  TerminalWebView,
  type TerminalWebViewHandle
} from '../../../../src/terminal/TerminalWebView'
import { StatusDot } from '../../../../src/components/StatusDot'
import { ActionSheetModal } from '../../../../src/components/ActionSheetModal'
import { TextInputModal } from '../../../../src/components/TextInputModal'
import {
  CustomKeyModal,
  loadCustomKeys,
  type CustomKey
} from '../../../../src/components/CustomKeyModal'
import { colors, spacing, radii, typography } from '../../../../src/theme/mobile-theme'

type Terminal = {
  handle: string
  title: string
  isActive: boolean
}

type TerminalCreateResult = {
  terminal: {
    handle: string
    title: string | null
  }
}

type MobileDisplayMode = 'auto' | 'phone' | 'desktop'

type AccessoryKey = { label: string; bytes: string; accessibilityLabel?: string }

const ACCESSORY_KEYS: AccessoryKey[] = [
  { label: 'Esc', bytes: '\x1b' },
  { label: 'Tab', bytes: '\t' },
  { label: '↑', bytes: '\x1b[A' },
  { label: '↓', bytes: '\x1b[B' },
  { label: '←', bytes: '\x1b[D' },
  { label: '→', bytes: '\x1b[C' },
  { label: 'Ctrl+C', bytes: '\x03', accessibilityLabel: 'Interrupt terminal' },
  { label: 'Ctrl+D', bytes: '\x04', accessibilityLabel: 'Send EOF' },
  { label: 'Ctrl+L', bytes: '\x0c', accessibilityLabel: 'Clear screen' },
  { label: 'Ctrl+Z', bytes: '\x1a', accessibilityLabel: 'Suspend process' },
  { label: 'Ctrl+R', bytes: '\x12', accessibilityLabel: 'Reverse search' },
  { label: 'Ctrl+A', bytes: '\x01', accessibilityLabel: 'Start of line' },
  { label: 'Ctrl+E', bytes: '\x05', accessibilityLabel: 'End of line' },
  { label: 'Ctrl+W', bytes: '\x17', accessibilityLabel: 'Delete word backward' },
  { label: 'Ctrl+U', bytes: '\x15', accessibilityLabel: 'Clear line before cursor' }
]

const STATUS_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  handshaking: 'Securing',
  connected: 'Connected',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting',
  'auth-failed': 'Auth failed'
}

function TerminalPaneView({
  handle,
  active,
  onRef,
  onWebReady
}: {
  handle: string
  active: boolean
  onRef: (handle: string, ref: TerminalWebViewHandle | null) => void
  onWebReady: (handle: string) => void
}) {
  const setRef = useCallback(
    (ref: TerminalWebViewHandle | null) => {
      onRef(handle, ref)
    },
    [handle, onRef]
  )

  return (
    <View
      pointerEvents={active ? 'auto' : 'none'}
      style={[styles.terminalPane, !active && styles.terminalPaneHidden]}
    >
      <TerminalWebView
        ref={setRef}
        style={styles.terminalWebView}
        onWebReady={() => onWebReady(handle)}
      />
    </View>
  )
}

export default function SessionScreen() {
  const {
    hostId,
    worktreeId,
    name: worktreeName,
    created
  } = useLocalSearchParams<{
    hostId: string
    worktreeId: string
    name?: string
    created?: string
  }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  // Why: shared client per host owned by RpcClientProvider. See
  // docs/mobile-shared-client-per-host.md.
  const { client, state: connState } = useHostClient(hostId)
  const [terminals, setTerminals] = useState<Terminal[]>([])
  const [terminalsLoaded, setTerminalsLoaded] = useState(false)
  const [input, setInput] = useState('')
  const [activeHandle, setActiveHandle] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [actionTarget, setActionTarget] = useState<Terminal | null>(null)
  const [renameTarget, setRenameTarget] = useState<Terminal | null>(null)
  const [customKeys, setCustomKeys] = useState<CustomKey[]>([])
  const [showCustomKeyModal, setShowCustomKeyModal] = useState(false)
  const [deleteKeyTarget, setDeleteKeyTarget] = useState<CustomKey | null>(null)
  // Why: in Expo SDK 55 edge-to-edge mode the OS does NOT resize the window when
  // the IME opens — the keyboard draws on top of the app. We track the keyboard
  // height ourselves and apply it as paddingBottom on the input/accessory area
  // so the input lifts above the IME and the terminal flex container shrinks.
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  // Why: server-authoritative display mode per terminal. The runtime is the
  // single source of truth — this state is populated from subscribe responses.
  const [terminalModes, setTerminalModes] = useState<Map<string, MobileDisplayMode>>(new Map())
  const deviceTokenRef = useRef<string | null>(null)
  const clientRef = useRef<RpcClient | null>(null)
  // Why: measured once from TerminalWebView on mount, then passed with every
  // subscribe call so the server can auto-fit the PTY to phone dimensions.
  const viewportRef = useRef<{ cols: number; rows: number } | null>(null)
  const viewportMeasuredRef = useRef(false)
  const terminalRefs = useRef<Map<string, TerminalWebViewHandle>>(new Map())
  const terminalUnsubsRef = useRef<Map<string, () => void>>(new Map())
  const subscribingHandlesRef = useRef<Set<string>>(new Set())
  const initializedHandlesRef = useRef<Set<string>>(new Set())
  // Why: WebViews load xterm.js from CDN asynchronously. Hidden WebViews
  // (opacity:0) may have delayed JS execution on iOS. We must not subscribe
  // until the WebView has fired web-ready, otherwise init() messages queue
  // and may not render reliably.
  const webReadyHandlesRef = useRef<Set<string>>(new Set())
  const activeHandleRef = useRef<string | null>(null)
  const subscribeSeqRef = useRef<Map<string, number>>(new Map())
  const sendingRef = useRef(false)
  // Why: tracks the pixel height of the terminal frame so measureFitDimensions
  // can use the exact container height instead of relying on window.innerHeight,
  // which can overstate the visible area due to layout timing.
  const terminalFrameHeightRef = useRef<number>(0)

  const canSend = connState === 'connected' && activeHandle != null

  const getTerminalRef = useCallback((handle: string | null) => {
    return handle ? terminalRefs.current.get(handle) : undefined
  }, [])

  const unsubscribeTerminal = useCallback((handle: string) => {
    terminalUnsubsRef.current.get(handle)?.()
    terminalUnsubsRef.current.delete(handle)
    subscribingHandlesRef.current.delete(handle)
    subscribeSeqRef.current.set(handle, (subscribeSeqRef.current.get(handle) ?? 0) + 1)
  }, [])

  const clearTerminalCache = useCallback(() => {
    for (const unsub of terminalUnsubsRef.current.values()) {
      unsub()
    }
    terminalUnsubsRef.current.clear()
    subscribingHandlesRef.current.clear()
    initializedHandlesRef.current.clear()
    webReadyHandlesRef.current.clear()
    subscribeSeqRef.current.clear()
    for (const term of terminalRefs.current.values()) {
      term.clear()
    }
  }, [])

  // Why: measures the phone viewport once from the first available TerminalWebView.
  // The viewport dims are passed with every subscribe call so the server can
  // auto-fit the PTY without a separate RPC round-trip.
  const measureViewportOnce = useCallback(
    async (handle: string) => {
      if (viewportMeasuredRef.current) return
      const dims = await getTerminalRef(handle)?.measureFitDimensions(
        terminalFrameHeightRef.current || undefined
      )
      if (dims) {
        viewportRef.current = dims
        viewportMeasuredRef.current = true
      }
    },
    [getTerminalRef]
  )

  const subscribeToTerminal = useCallback(
    (handle: string) => {
      if (!client) return
      if (terminalUnsubsRef.current.has(handle)) return
      if (subscribingHandlesRef.current.has(handle)) return
      if (!getTerminalRef(handle)) {
        return
      }

      subscribingHandlesRef.current.add(handle)
      const seq = (subscribeSeqRef.current.get(handle) ?? 0) + 1
      subscribeSeqRef.current.set(handle, seq)

      // Why: server handles auto-fit on subscribe — no terminal.focus call needed.
      // The viewport is embedded in the subscribe params so the server resizes
      // the PTY before serializing scrollback. This eliminates the focus→safeFit
      // race and the measure→resize→resubscribe pipeline.
      const unsub = client.subscribe(
        'terminal.subscribe',
        {
          terminal: handle,
          client: { id: deviceTokenRef.current!, type: 'mobile' as const },
          viewport: viewportRef.current ?? undefined
        },
        (result) => {
          if (subscribeSeqRef.current.get(handle) !== seq) return
          const data = result as Record<string, unknown>
          if (data.type === 'scrollback') {
            if (initializedHandlesRef.current.has(handle)) return
            const cols = (data.cols as number) || 80
            const rows = (data.rows as number) || 24
            const initialData =
              typeof data.serialized === 'string' && data.serialized.length > 0
                ? data.serialized
                : ''
            getTerminalRef(handle)?.init(cols, rows, initialData)
            initializedHandlesRef.current.add(handle)
            if (data.displayMode) {
              setTerminalModes((prev) =>
                new Map(prev).set(handle, data.displayMode as MobileDisplayMode)
              )
            }
            // Why: cold-start fit-to-screen guard. The first init() runs
            // before xterm's DOM/canvas has fully laid out, so the
            // applyFitScale that init queues internally can land while
            // term.element.scrollWidth is still stale or zero — leaving
            // the terminal un-zoomed until the user toggles the resize
            // button. Re-fire resetZoom after a short delay so it runs
            // against a settled DOM. Mirrors the 'resized' handler below.
            setTimeout(() => getTerminalRef(handle)?.resetZoom(), 200)
            // Why: viewport measurement needs xterm to be initialized (cell
            // dimensions come from the renderer). On the first subscribe the
            // WebView hasn't loaded yet, so viewportRef is null and the server
            // can't auto-fit. After the first init we can measure, then
            // resubscribe so the server gets the viewport and phone-fits.
            if (!viewportMeasuredRef.current) {
              void (async () => {
                const dims = await getTerminalRef(handle)?.measureFitDimensions(
                  terminalFrameHeightRef.current || undefined
                )
                if (dims && !viewportMeasuredRef.current) {
                  viewportRef.current = dims
                  viewportMeasuredRef.current = true
                  unsubscribeTerminal(handle)
                  initializedHandlesRef.current.delete(handle)
                  subscribeToTerminal(handle)
                }
              })()
            }
          } else if (data.type === 'data') {
            getTerminalRef(handle)?.write(data.chunk as string)
          } else if (data.type === 'resized') {
            // Why: inline resize event — the server changed the PTY dimensions
            // (mode toggle or desktop restore). Reinitialize xterm at the new
            // dims with fresh scrollback. No resubscribe needed.
            const cols = (data.cols as number) || 80
            const rows = (data.rows as number) || 24
            const serialized =
              typeof data.serialized === 'string' && data.serialized.length > 0
                ? data.serialized
                : ''
            getTerminalRef(handle)?.init(cols, rows, serialized)
            if (data.displayMode) {
              setTerminalModes((prev) =>
                new Map(prev).set(handle, data.displayMode as MobileDisplayMode)
              )
            }
            setTimeout(() => getTerminalRef(handle)?.resetZoom(), 200)
          }
        }
      )

      if (subscribeSeqRef.current.get(handle) === seq) {
        terminalUnsubsRef.current.set(handle, unsub)
      } else {
        unsub()
      }
      subscribingHandlesRef.current.delete(handle)
    },
    [client, getTerminalRef]
  )

  // Why: toggles between phone and desktop mode via server RPC. The server
  // handles the actual resize and emits a 'resized' event on the existing
  // subscription stream — no client-side state tracking needed.
  const toggleInFlightRef = useRef<Set<string>>(new Set())
  const toggleDisplayMode = useCallback(
    async (handle: string) => {
      if (!client) return
      if (toggleInFlightRef.current.has(handle)) return
      const current = terminalModes.get(handle) ?? 'auto'
      const next: MobileDisplayMode = current === 'auto' || current === 'phone' ? 'desktop' : 'auto'
      toggleInFlightRef.current.add(handle)
      try {
        await client.sendRequest('terminal.setDisplayMode', {
          terminal: handle,
          mode: next,
          // Why: presence-lock take-floor signal. Sending mode=auto/phone
          // is a deliberate "I want to drive at phone dims" gesture.
          ...(deviceTokenRef.current
            ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
            : {})
        })
      } catch {
        // Mode change failed — server state unchanged, UI stays in sync.
      } finally {
        toggleInFlightRef.current.delete(handle)
      }
    },
    [client, terminalModes]
  )

  const lastKnownTerminalCountRef = useRef(0)

  const fetchTerminals = useCallback(
    async (opts: { allowEmptyLoaded?: boolean } = {}) => {
      if (!client) return
      const allowEmptyLoaded = opts.allowEmptyLoaded ?? true

      try {
        const response = await client.sendRequest('terminal.list', {
          worktree: `id:${worktreeId}`
        })
        if (response.ok) {
          const result = (response as RpcSuccess).result as { terminals: Terminal[] }

          if (result.terminals.length === 0 && !allowEmptyLoaded) {
            return
          }
          // Why: protect against transient empty responses from the server
          // during rapid tab switching or RPC timing. If we previously had
          // terminals and the server now says 0, require a second consecutive
          // empty to confirm. This prevents the UI from flashing empty during
          // rapid interactions while still allowing genuine cleanup.
          if (result.terminals.length === 0 && lastKnownTerminalCountRef.current > 0) {
            lastKnownTerminalCountRef.current = 0
            return
          }

          const liveHandles = new Set(result.terminals.map((terminal) => terminal.handle))
          for (const handle of Array.from(terminalUnsubsRef.current.keys())) {
            if (!liveHandles.has(handle)) {
              unsubscribeTerminal(handle)
              terminalRefs.current.delete(handle)
              initializedHandlesRef.current.delete(handle)
            }
          }
          lastKnownTerminalCountRef.current = result.terminals.length
          const current = activeHandleRef.current

          // Why: defense-in-depth dedupe. If the server ever returns a list
          // with the same handle twice (race during rename/split, or stale
          // process tracking), React would throw 'two children with same
          // key' on render. Keep the first occurrence — list order matters
          // for the tab strip, and createParams puts new tabs at the end.
          const seen = new Set<string>()
          const deduped = result.terminals.filter((t) => {
            if (seen.has(t.handle)) return false
            seen.add(t.handle)
            return true
          })

          setTerminals(deduped)
          setTerminalsLoaded(true)

          if (!current || !result.terminals.some((t) => t.handle === current)) {
            const active = result.terminals.find((t) => t.isActive) ?? result.terminals[0]
            if (active) {
              activeHandleRef.current = active.handle
              setActiveHandle(active.handle)
              subscribeToTerminal(active.handle)
            } else {
              activeHandleRef.current = null
              setActiveHandle(null)
            }
          }
        }
      } catch {
        // Failed to list terminals
      }
    },
    [client, worktreeId, subscribeToTerminal, unsubscribeTerminal]
  )

  // Why: keep clientRef in sync with the shared client from
  // useHostClient() so the existing imperative call sites
  // (clientRef.current.sendRequest...) keep working without churn.
  useEffect(() => {
    clientRef.current = client
    return () => {
      clearTerminalCache()
    }
  }, [client, clearTerminalCache])

  // Why: deviceToken is read from host record so feature code can pass
  // `client.id` on subscribe/send for driver-state-machine identity.
  // The shared client itself stays alive across screens; we just need
  // the token alongside the client.
  useEffect(() => {
    if (!hostId) return
    let stale = false
    void loadHosts().then((hosts) => {
      if (stale) return
      const host = hosts.find((h) => h.id === hostId)
      if (host) deviceTokenRef.current = host.deviceToken
    })
    return () => {
      stale = true
    }
  }, [hostId])

  useEffect(() => {
    void loadCustomKeys().then(setCustomKeys)
  }, [])

  // Why: drive the bottom padding from the keyboard height (edge-to-edge mode
  // doesn't resize the window) and refit xterm once the layout settles so the
  // terminal grid matches the new visible area. iOS exposes 'will' events that
  // animate in sync with the IME; Android only fires 'did' events reliably.
  // Also drives re-measurement when other layout-affecting state changes
  // (e.g. tab strip toggling visibility when the terminal count crosses
  // 0↔1 — without this, a freshly-created 2nd tab subscribes with a
  // stale viewport that doesn't account for the now-visible tab strip,
  // and the server phone-fits to dims a few rows too tall).
  const refitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleViewportRefit = useCallback(() => {
    if (refitTimerRef.current) clearTimeout(refitTimerRef.current)
    refitTimerRef.current = setTimeout(() => {
      const handle = activeHandleRef.current
      if (!handle) return
      const ref = terminalRefs.current.get(handle)
      if (!ref) return
      void (async () => {
        const dims = await ref.measureFitDimensions(terminalFrameHeightRef.current || undefined)
        if (!dims) return
        const prev = viewportRef.current
        if (prev && prev.cols === dims.cols && prev.rows === dims.rows) return
        viewportRef.current = dims
        viewportMeasuredRef.current = true
        // Why: prefer the in-place viewport update RPC over the legacy
        // unsubscribe → subscribe cycle. This keeps the server-side
        // mobile subscriber record alive (no driver=idle blip on the
        // desktop banner; no false phone-fit baseline capture on the
        // re-subscribe). See docs/mobile-presence-lock.md.
        const rpc = clientRef.current
        const deviceToken = deviceTokenRef.current
        if (rpc && deviceToken) {
          try {
            const response = await rpc.sendRequest('terminal.updateViewport', {
              terminal: handle,
              client: { id: deviceToken, type: 'mobile' as const },
              viewport: dims
            })
            if (response.ok) return
          } catch {
            // Fall through to legacy resubscribe.
          }
        }
        unsubscribeTerminal(handle)
        initializedHandlesRef.current.delete(handle)
        subscribeToTerminal(handle)
      })()
    }, 150)
  }, [subscribeToTerminal, unsubscribeTerminal])

  useEffect(() => {
    const onShow = (e: KeyboardEvent) => {
      setKeyboardHeight(e.endCoordinates?.height ?? 0)
      scheduleViewportRefit()
    }
    const onHide = () => {
      setKeyboardHeight(0)
      scheduleViewportRefit()
    }
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const showSub = Keyboard.addListener(showEvent, onShow)
    const hideSub = Keyboard.addListener(hideEvent, onHide)
    return () => {
      if (refitTimerRef.current) clearTimeout(refitTimerRef.current)
      showSub.remove()
      hideSub.remove()
    }
  }, [scheduleViewportRefit])

  // Why: the tab strip is hidden when only one terminal exists and shown
  // once a second is created. Crossing the 1↔2 boundary changes the
  // visible terminal area by ~40px, so the cached viewport dims in
  // viewportRef become stale. Mark the viewport as un-measured so the
  // next subscribe path's self-correcting loop (init → measure →
  // resubscribe-with-fresh-viewport, see the !viewportMeasuredRef branch
  // above) re-runs against the new layout. Also schedule an explicit
  // refit to cover the case where no new subscribe is happening.
  const tabStripVisible = terminals.length > 1
  const prevTabStripVisibleRef = useRef(tabStripVisible)
  useEffect(() => {
    if (prevTabStripVisibleRef.current === tabStripVisible) return
    prevTabStripVisibleRef.current = tabStripVisible
    viewportMeasuredRef.current = false
    scheduleViewportRefit()
  }, [tabStripVisible, scheduleViewportRefit])

  useEffect(() => {
    if (hostId && worktreeId) {
      void AsyncStorage.setItem(
        'orca:last-visited-worktree',
        JSON.stringify({ hostId, worktreeId })
      )
    }
  }, [hostId, worktreeId])

  const handleDeleteCustomKey = useCallback(
    async (key: CustomKey) => {
      const updated = customKeys.filter((k) => k.id !== key.id)
      setCustomKeys(updated)
      await AsyncStorage.setItem('orca:custom-accessory-keys', JSON.stringify(updated))
    },
    [customKeys]
  )

  useEffect(() => {
    clearTerminalCache()
    activeHandleRef.current = null
    setActiveHandle(null)
    setTerminals([])
  }, [clearTerminalCache, worktreeId])

  useEffect(() => {
    if (connState !== 'connected') return
    // Why: on reconnect the RPC client auto-resends terminal.subscribe,
    // creating new server-side handlers. Clear local subscription state
    // so subscribeToTerminal's guards don't block fresh subscriptions,
    // and clear xterm buffers so the new scrollback snapshot replaces
    // stale content (including data that arrived while disconnected).
    clearTerminalCache()
    setTerminalsLoaded(false)
    let disposed = false
    const timers: ReturnType<typeof setTimeout>[] = []
    function addTimer(fn: () => void, ms: number) {
      if (disposed) return
      timers.push(setTimeout(fn, ms))
    }
    void (async () => {
      if (client && created !== '1') {
        await client
          .sendRequest('worktree.activate', {
            worktree: `id:${worktreeId}`
          })
          .catch(() => null)
      }
      if (disposed) return
      await fetchTerminals({ allowEmptyLoaded: false })
      if (disposed) return
      addTimer(() => void fetchTerminals({ allowEmptyLoaded: false }), 750)
      addTimer(() => void fetchTerminals({ allowEmptyLoaded: true }), 1500)
      if (client && created === '1') {
        addTimer(() => {
          if (activeHandleRef.current) return
          void (async () => {
            await client
              .sendRequest('worktree.activate', {
                worktree: `id:${worktreeId}`
              })
              .catch(() => null)
            if (disposed) return
            await fetchTerminals({ allowEmptyLoaded: true })
            addTimer(() => void fetchTerminals({ allowEmptyLoaded: true }), 750)
          })()
        }, 1800)
      }
    })()
    return () => {
      disposed = true
      for (const t of timers) clearTimeout(t)
    }
  }, [client, connState, created, fetchTerminals, worktreeId])

  useEffect(() => {
    if (connState !== 'connected') return
    const interval = setInterval(() => {
      void fetchTerminals()
    }, 2000)
    return () => clearInterval(interval)
  }, [connState, fetchTerminals])

  // Why: unsubscribe the old terminal so the server restores its desktop dims
  // (clearing the phone-fit banner), then subscribe the new terminal with the
  // measured viewport so the server phone-fits it. Also call terminal.focus
  // so the desktop renderer follows the mobile user's active terminal.
  const switchTab = useCallback(
    (handle: string) => {
      const prev = activeHandleRef.current
      activeHandleRef.current = handle
      setActiveHandle(handle)
      if (prev && prev !== handle) {
        unsubscribeTerminal(prev)
        initializedHandlesRef.current.delete(prev)
      }
      // Force a fresh subscribe even if eagerly subscribed without viewport
      if (terminalUnsubsRef.current.has(handle)) {
        unsubscribeTerminal(handle)
        initializedHandlesRef.current.delete(handle)
      }
      subscribeToTerminal(handle)
      if (client) {
        void client.sendRequest('terminal.focus', { terminal: handle }).catch(() => {})
      }
    },
    [client, subscribeToTerminal, unsubscribeTerminal]
  )

  // Why: just store the ref. Subscription is deferred to handleTerminalWebReady
  // which fires after the WebView has loaded xterm.js and is ready to process
  // init messages. This prevents the blank terminal race where init() was
  // queued before the WebView loaded.
  const setTerminalWebViewRef = useCallback((handle: string, ref: TerminalWebViewHandle | null) => {
    if (ref) {
      terminalRefs.current.set(handle, ref)
    } else {
      terminalRefs.current.delete(handle)
    }
  }, [])

  const handleTerminalWebReady = useCallback(
    (handle: string) => {
      const wasAlreadyReady = webReadyHandlesRef.current.has(handle)
      webReadyHandlesRef.current.add(handle)
      if (wasAlreadyReady && initializedHandlesRef.current.has(handle)) {
        // Why: the native WebView reloaded (Metro hot reload or Android
        // process churn). The old xterm buffer is gone, so force a fresh
        // scrollback snapshot. Only resubscribe if this is a reload — on
        // first load the subscription is already running and pendingMessages
        // will flush the queued init after this callback returns.
        unsubscribeTerminal(handle)
        initializedHandlesRef.current.delete(handle)
        if (handle === activeHandleRef.current) {
          subscribeToTerminal(handle)
        }
        return
      }
      // Why: on first web-ready, the initial subscribeToTerminal call from
      // fetchTerminals may have been skipped (reason=no-ref, WebView wasn't
      // mounted yet). Now that the WebView is ready, subscribe if this is the
      // active terminal and no subscription is running.
      if (handle === activeHandleRef.current && !terminalUnsubsRef.current.has(handle)) {
        void measureViewportOnce(handle)
        subscribeToTerminal(handle)
      }
    },
    [measureViewportOnce, subscribeToTerminal, unsubscribeTerminal]
  )

  async function handleSend() {
    if (!client || !activeHandle || sendingRef.current) return
    sendingRef.current = true

    const text = input
    setInput('')

    try {
      await client.sendRequest('terminal.send', {
        terminal: activeHandle,
        text,
        enter: true,
        // Why: presence-lock take-floor signal. Identifies this phone as
        // the active mobile actor so the runtime can resolve multi-mobile
        // contention (most-recent-actor's viewport wins).
        ...(deviceTokenRef.current
          ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
          : {})
      })
    } catch {
      setInput(text)
    } finally {
      sendingRef.current = false
    }
  }

  async function handleAccessoryKey(bytes: string) {
    if (!client || !activeHandle || !canSend) return

    try {
      await client.sendRequest('terminal.send', {
        terminal: activeHandle,
        text: bytes,
        enter: false,
        ...(deviceTokenRef.current
          ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
          : {})
      })
    } catch {
      // Transient failure
    }
  }

  async function handleCreateTerminal() {
    if (!client || creating) return

    setCreating(true)
    setCreateError('')

    try {
      const response = await client.sendRequest('terminal.create', {
        worktree: `id:${worktreeId}`
      })
      if (response.ok) {
        const result = (response as RpcSuccess).result as TerminalCreateResult
        const created = result.terminal
        // Why: unsubscribe the old active terminal so the server restores its
        // desktop dims. Without this, the old terminal's mobile subscription
        // stays alive and its restore timer is never set.
        const prev = activeHandleRef.current
        if (prev) {
          unsubscribeTerminal(prev)
          initializedHandlesRef.current.delete(prev)
        }
        activeHandleRef.current = created.handle
        setActiveHandle(created.handle)
        setTerminals((prev) => {
          // Why: guard against duplicates if a parallel fetchTerminals()
          // already inserted this handle. Without this, React throws
          // 'two children with the same key' when both the optimistic
          // insert and a canonical refetch race during creation.
          if (prev.some((t) => t.handle === created.handle)) return prev
          return [
            ...prev,
            { handle: created.handle, title: created.title || 'Terminal', isActive: true }
          ]
        })
        subscribeToTerminal(created.handle)
        setTimeout(() => void fetchTerminals(), 500)
      } else {
        setCreateError('Failed to create terminal')
      }
    } catch {
      setCreateError('Failed to create terminal')
    } finally {
      setCreating(false)
    }
  }

  async function handleRenameTerminal(value: string) {
    if (!client || !renameTarget) return
    const target = renameTarget
    setRenameTarget(null)

    try {
      const title = value.trim()
      const response = await client.sendRequest('terminal.rename', {
        terminal: target.handle,
        title
      })
      if (response.ok) {
        setTerminals((prev) =>
          prev.map((terminal) =>
            terminal.handle === target.handle
              ? { ...terminal, title: title || 'Terminal' }
              : terminal
          )
        )
        setTimeout(() => void fetchTerminals(), 300)
      }
    } catch {
      // Rename failed — refresh will restore the server title.
    }
  }

  async function handleCloseTerminal(target: Terminal) {
    if (!client) return

    try {
      const response = await client.sendRequest('terminal.close', {
        terminal: target.handle
      })
      if (response.ok) {
        unsubscribeTerminal(target.handle)
        terminalRefs.current.delete(target.handle)
        initializedHandlesRef.current.delete(target.handle)
        const next = terminals.filter((terminal) => terminal.handle !== target.handle)
        setTerminals(next)
        if (activeHandleRef.current === target.handle) {
          const replacement = next[0] ?? null
          activeHandleRef.current = replacement?.handle ?? null
          setActiveHandle(replacement?.handle ?? null)
          if (replacement) {
            subscribeToTerminal(replacement.handle)
          }
        }
        setTimeout(() => void fetchTerminals(), 300)
      }
    } catch {
      // Close failed — keep the local tab list unchanged.
    }
  }

  const isPhoneMode = (handle: string | null): boolean => {
    if (!handle) return false
    const mode = terminalModes.get(handle)
    return mode === 'auto' || mode === 'phone' || mode === undefined
  }

  const showLoadingState = connState === 'connected' && !terminalsLoaded
  const showEmptyState =
    connState === 'connected' && terminalsLoaded && terminals.length === 0 && !activeHandle
  const terminalSummary =
    connState === 'connected'
      ? !terminalsLoaded
        ? 'Loading terminals'
        : terminals.length === 1
          ? '1 terminal'
          : `${terminals.length} terminals`
      : STATUS_LABELS[connState]

  // Why: on Android (Samsung 3-button) the keyboard event reports only the IME
  // height; the system nav bar sits below the keyboard and adds its own height
  // on top, so we must add insets.bottom too or the input stays clipped behind
  // the nav bar. On iOS the keyboard coordinates already include the home
  // indicator region, so adding insets.bottom would double-count.
  const bottomPadding =
    keyboardHeight > 0
      ? Platform.OS === 'ios'
        ? keyboardHeight
        : keyboardHeight + insets.bottom
      : insets.bottom

  return (
    <View style={styles.container}>
      <View style={styles.kavInner}>
        <SafeAreaView style={styles.sessionChrome} edges={['top']}>
          <View style={styles.sessionTopBar}>
            <Pressable
              style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
              onPress={() => router.back()}
              hitSlop={8}
              accessibilityLabel="Back to worktrees"
            >
              <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
            </Pressable>

            <View style={styles.sessionTitleBlock}>
              <Text style={styles.sessionTitle} numberOfLines={1}>
                {worktreeName || 'Terminal'}
              </Text>
              <View style={styles.sessionMetaRow}>
                <StatusDot state={connState} />
                <Text style={styles.sessionMetaText} numberOfLines={1}>
                  {terminalSummary}
                </Text>
              </View>
            </View>
          </View>

          {terminals.length > 0 && (
            <View style={styles.tabBar}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.tabScroll}
                contentContainerStyle={styles.tabContent}
              >
                {terminals.map((t) => (
                  <Pressable
                    key={t.handle}
                    style={[styles.tab, t.handle === activeHandle && styles.tabActive]}
                    onPress={() => switchTab(t.handle)}
                    onLongPress={() => {
                      triggerMediumImpact()
                      setActionTarget(t)
                    }}
                    delayLongPress={400}
                  >
                    <Text
                      style={[styles.tabText, t.handle === activeHandle && styles.tabTextActive]}
                      numberOfLines={1}
                    >
                      {t.title || 'Terminal'}
                    </Text>
                  </Pressable>
                ))}
                <Pressable
                  style={({ pressed }) => [
                    styles.newTerminalButton,
                    pressed && styles.newTerminalButtonPressed,
                    (creating || connState !== 'connected') && styles.newTerminalButtonDisabled
                  ]}
                  disabled={creating || connState !== 'connected'}
                  onPress={() => void handleCreateTerminal()}
                  accessibilityLabel="New terminal"
                >
                  <Plus size={16} color={colors.textSecondary} strokeWidth={2.2} />
                </Pressable>
              </ScrollView>
            </View>
          )}
        </SafeAreaView>

        {showLoadingState ? (
          <View style={styles.emptyState}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
          </View>
        ) : showEmptyState ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No terminals in this session</Text>
            {createError ? <Text style={styles.createError}>{createError}</Text> : null}
            <Pressable
              style={[styles.createButton, creating && styles.createButtonDisabled]}
              disabled={creating}
              onPress={() => void handleCreateTerminal()}
            >
              <Text style={styles.createButtonText}>
                {creating ? 'Creating…' : 'Create Terminal'}
              </Text>
            </Pressable>
          </View>
        ) : (
          <View
            style={styles.terminalFrame}
            onLayout={(e) => {
              terminalFrameHeightRef.current = e.nativeEvent.layout.height
            }}
          >
            {terminals.map((terminal) => (
              <TerminalPaneView
                key={terminal.handle}
                handle={terminal.handle}
                active={terminal.handle === activeHandle}
                onRef={setTerminalWebViewRef}
                onWebReady={handleTerminalWebReady}
              />
            ))}
          </View>
        )}

        {/* Why: bottomPadding lifts the entire input region above the keyboard
            (when shown) or above the system nav bar / home indicator (when hidden). */}
        <View style={{ paddingBottom: bottomPadding }}>
          {/* Accessory keys */}
          <View style={styles.accessoryBar}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.accessoryContent}
            >
              <Pressable
                style={({ pressed }) => [
                  styles.accessoryKey,
                  pressed && styles.accessoryKeyPressed,
                  !canSend && styles.accessoryKeyDisabled
                ]}
                disabled={!canSend}
                onPress={() => {
                  if (activeHandle) {
                    void toggleDisplayMode(activeHandle)
                  }
                }}
                accessibilityLabel={
                  isPhoneMode(activeHandle) ? 'Switch to desktop mode' : 'Switch to phone mode'
                }
              >
                {isPhoneMode(activeHandle) ? (
                  <Monitor size={14} color={canSend ? colors.textSecondary : colors.textMuted} />
                ) : (
                  <Smartphone size={14} color={canSend ? colors.textSecondary : colors.textMuted} />
                )}
              </Pressable>
              {ACCESSORY_KEYS.map((key) => (
                <Pressable
                  key={key.label}
                  style={({ pressed }) => [
                    styles.accessoryKey,
                    pressed && styles.accessoryKeyPressed,
                    !canSend && styles.accessoryKeyDisabled
                  ]}
                  disabled={!canSend}
                  onPress={() => void handleAccessoryKey(key.bytes)}
                  accessibilityLabel={key.accessibilityLabel ?? `Send ${key.label}`}
                >
                  <Text
                    style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}
                  >
                    {key.label}
                  </Text>
                </Pressable>
              ))}
              {customKeys.map((key) => (
                <Pressable
                  key={key.id}
                  style={({ pressed }) => [
                    styles.accessoryKey,
                    styles.customAccessoryKey,
                    pressed && styles.accessoryKeyPressed,
                    !canSend && styles.accessoryKeyDisabled
                  ]}
                  disabled={!canSend}
                  onPress={() => void handleAccessoryKey(key.bytes)}
                  onLongPress={() => {
                    triggerMediumImpact()
                    setDeleteKeyTarget(key)
                  }}
                  delayLongPress={400}
                  accessibilityLabel={`Send ${key.label}`}
                >
                  <Text
                    style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}
                  >
                    {key.label}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                style={({ pressed }) => [
                  styles.accessoryKey,
                  pressed && styles.accessoryKeyPressed
                ]}
                onPress={() => setShowCustomKeyModal(true)}
                accessibilityLabel="Add custom shortcut"
              >
                <Plus size={14} color={colors.textSecondary} strokeWidth={2.2} />
              </Pressable>
            </ScrollView>
          </View>

          {/* Input bar */}
          <View style={styles.inputBar}>
            <TextInput
              style={styles.textInput}
              value={input}
              onChangeText={setInput}
              placeholder="Type a command…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="send"
              editable={canSend}
              onSubmitEditing={() => void handleSend()}
            />
            <Pressable
              style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
              disabled={!canSend}
              onPress={() => void handleSend()}
              accessibilityLabel="Send command"
            >
              <ArrowUp size={18} color={colors.textSecondary} strokeWidth={2.5} />
            </Pressable>
          </View>
        </View>
      </View>

      <ActionSheetModal
        visible={actionTarget != null}
        title={actionTarget?.title || 'Terminal'}
        actions={[
          ...(actionTarget
            ? [
                {
                  label: isPhoneMode(actionTarget.handle) ? 'Switch to Desktop' : 'Switch to Phone',
                  icon: isPhoneMode(actionTarget.handle) ? Monitor : Smartphone,
                  onPress: () => {
                    const target = actionTarget
                    setActionTarget(null)
                    if (target) {
                      void toggleDisplayMode(target.handle)
                    }
                  }
                }
              ]
            : []),
          {
            label: 'Rename',
            onPress: () => {
              const target = actionTarget
              setActionTarget(null)
              if (target) {
                setRenameTarget(target)
              }
            }
          },
          {
            label: 'Close',
            destructive: true,
            onPress: () => {
              const target = actionTarget
              setActionTarget(null)
              if (target) {
                void handleCloseTerminal(target)
              }
            }
          }
        ]}
        onClose={() => setActionTarget(null)}
      />
      <TextInputModal
        visible={renameTarget != null}
        title="Rename Terminal"
        defaultValue={renameTarget?.title || 'Terminal'}
        placeholder="Terminal name"
        onSubmit={(value) => void handleRenameTerminal(value)}
        onCancel={() => setRenameTarget(null)}
      />
      <CustomKeyModal
        visible={showCustomKeyModal}
        onClose={() => setShowCustomKeyModal(false)}
        onKeysChanged={setCustomKeys}
      />
      <ActionSheetModal
        visible={deleteKeyTarget != null}
        title={deleteKeyTarget?.label ?? 'Shortcut'}
        message="Remove this custom shortcut?"
        actions={[
          {
            label: 'Remove',
            destructive: true,
            onPress: () => {
              if (deleteKeyTarget) {
                void handleDeleteCustomKey(deleteKeyTarget)
              }
              setDeleteKeyTarget(null)
            }
          }
        ]}
        onClose={() => setDeleteKeyTarget(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  kavInner: {
    flex: 1
  },
  sessionChrome: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  sessionTopBar: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs
  },
  backButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  sessionTitleBlock: {
    flex: 1,
    minWidth: 0
  },
  sessionTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600'
  },
  sessionMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2
  },
  sessionMetaText: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  tabScroll: {
    flex: 1,
    maxHeight: 36
  },
  tabContent: {
    paddingLeft: spacing.sm,
    paddingRight: spacing.sm
  },
  tab: {
    width: 128,
    maxWidth: 128,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  tabActive: {
    borderBottomColor: colors.accentBlue
  },
  tabText: {
    maxWidth: '100%',
    color: colors.textSecondary,
    fontSize: 13
  },
  tabTextActive: {
    color: colors.textPrimary
  },
  newTerminalButton: {
    width: 40,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  newTerminalButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  newTerminalButtonDisabled: {
    opacity: 0.45
  },
  terminalFrame: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
    overflow: 'hidden'
  },
  terminalPane: {
    ...StyleSheet.absoluteFillObject
  },
  terminalPaneHidden: {
    opacity: 0
  },
  terminalWebView: {
    flex: 1
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    marginBottom: spacing.lg
  },
  createError: {
    color: colors.statusRed,
    fontSize: 13,
    marginBottom: spacing.sm
  },
  createButton: {
    backgroundColor: colors.bgRaised,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button
  },
  createButtonDisabled: {
    opacity: 0.5
  },
  createButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  accessoryBar: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  accessoryContent: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xs
  },
  accessoryKey: {
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: radii.button,
    minWidth: 36,
    alignItems: 'center'
  },
  accessoryKeyPressed: {
    backgroundColor: colors.borderSubtle
  },
  customAccessoryKey: {
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  accessoryKeyDisabled: {
    opacity: 0.35
  },
  accessoryKeyText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: typography.monoFamily
  },
  accessoryKeyTextDisabled: {
    color: colors.textMuted
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  textInput: {
    flex: 1,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    fontFamily: typography.monoFamily,
    marginRight: spacing.sm
  },
  sendButton: {
    backgroundColor: colors.bgRaised,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sendButtonDisabled: {
    opacity: 0.35
  }
})
