import { useState, useEffect, useRef, useCallback } from 'react'
import { Animated, AppState, type AppStateStatus } from 'react-native'
import * as Clipboard from 'expo-clipboard'
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
import {
  triggerMediumImpact,
  triggerSelection,
  triggerSuccess,
  triggerError,
  triggerEdgeBump
} from '../../../../src/platform/haptics'
import {
  TerminalWebView,
  type TerminalModes,
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

type AccessoryKey = {
  label: string
  bytes: string
  accessibilityLabel?: string
  repeatable?: boolean
}

const ACCESSORY_KEYS: AccessoryKey[] = [
  { label: 'Esc', bytes: '\x1b' },
  { label: 'Tab', bytes: '\t' },
  { label: '⌫', bytes: '\x7f', accessibilityLabel: 'Backspace', repeatable: true },
  { label: 'Del', bytes: '\x1b[3~', accessibilityLabel: 'Forward delete', repeatable: true },
  { label: '↑', bytes: '\x1b[A', repeatable: true },
  { label: '↓', bytes: '\x1b[B', repeatable: true },
  { label: '←', bytes: '\x1b[D', repeatable: true },
  { label: '→', bytes: '\x1b[C', repeatable: true },
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
  onWebReady,
  onSelectionMode,
  onSelectionCopy,
  onSelectionEvicted,
  onModesChanged,
  onHaptic
}: {
  handle: string
  active: boolean
  onRef: (handle: string, ref: TerminalWebViewHandle | null) => void
  onWebReady: (handle: string) => void
  onSelectionMode: (handle: string, active: boolean) => void
  onSelectionCopy: (handle: string, text: string) => void
  onSelectionEvicted: (handle: string) => void
  onModesChanged: (handle: string, modes: TerminalModes) => void
  onHaptic: (kind: 'selection' | 'success' | 'error' | 'edge-bump') => void
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
        onSelectionMode={(a) => onSelectionMode(handle, a)}
        onSelectionCopy={(t) => onSelectionCopy(handle, t)}
        onSelectionEvicted={() => onSelectionEvicted(handle)}
        onModesChanged={(m) => onModesChanged(handle, m)}
        onHaptic={onHaptic}
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
  const [selectModeActive, setSelectModeActive] = useState(false)
  const [canPaste, setCanPaste] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  const toastOpacityRef = useRef(new Animated.Value(0))
  // Why: WebView pushes terminal modes (bracketed-paste, alt-screen) on every
  // change so paste reads a synchronous snapshot — no round-trip required.
  const ptyModesRef = useRef<Map<string, TerminalModes>>(new Map())
  const initialModesSeenRef = useRef<Set<string>>(new Set())
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
  // Why: server-side layout state machine emits a monotonic seq on every
  // applyLayout. Track the highest seq we've observed per handle and drop
  // any scrollback/resized event with a strictly older seq — these are
  // late-arriving events from a superseded layout (e.g. phone-fit dims
  // landing after the user toggled to desktop). Drops below `>20`-window
  // gap reset (treat as a fresh subscription, e.g. server restart).
  const layoutSeqRef = useRef<Map<string, number>>(new Map())
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
    // Why: a fresh subscription will land on a new server-side state machine
    // run (or the same one with a higher seq); reset the high-water mark so
    // the first scrollback isn't accidentally dropped as stale.
    layoutSeqRef.current.delete(handle)
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
    layoutSeqRef.current.clear()
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
          // Why: stale-event filter. Server-side state machine bumps a
          // monotonic seq on every applyLayout. Drop `resized` events
          // whose seq is strictly older than what we've already observed
          // for this handle — they're late-arriving from a superseded
          // layout. `scrollback` is the response to a fresh subscribe,
          // so it always resets the high-water mark regardless of seq
          // (post-WS-reconnect or post-resubscribe the server may emit
          // scrollback at a seq lower than what we'd seen pre-reconnect;
          // dropping it would leave the user with a blank terminal).
          const eventSeq = typeof data.seq === 'number' ? data.seq : null
          if (eventSeq != null && data.type === 'resized') {
            const last = layoutSeqRef.current.get(handle)
            if (last != null && eventSeq < last && last - eventSeq <= 20) {
              console.log('[fit][session] DROP-stale-seq', {
                handle: handle.slice(-8),
                type: data.type,
                eventSeq,
                lastSeq: last,
                cols: data.cols,
                rows: data.rows,
                displayMode: data.displayMode
              })
              return
            }
            layoutSeqRef.current.set(handle, eventSeq)
          } else if (eventSeq != null && data.type === 'scrollback') {
            layoutSeqRef.current.set(handle, eventSeq)
          }
          if (data.type === 'scrollback') {
            if (initializedHandlesRef.current.has(handle)) {
              return
            }
            const cols = (data.cols as number) || 80
            const rows = (data.rows as number) || 24
            const scrollbackCols = cols
            const scrollbackRows = rows
            const initialData =
              typeof data.serialized === 'string' && data.serialized.length > 0
                ? data.serialized
                : ''
            const ref = getTerminalRef(handle)
            // Why: previously we set `initializedHandlesRef` even when the
            // WebView wasn't mounted yet (ref=null). The init message went
            // nowhere, but the flag stayed true, so any subsequent scrollback
            // for THIS handle was silently dropped → blank terminal. Only
            // mark initialized if init() actually reached the WebView.
            if (!ref) {
              console.log('[fit][session] scrollback DROPPED — no terminal ref', {
                handle: handle.slice(-8),
                cols,
                rows
              })
              return
            }
            ref.init(cols, rows, initialData)
            initializedHandlesRef.current.add(handle)
            if (data.displayMode) {
              setTerminalModes((prev) =>
                new Map(prev).set(handle, data.displayMode as MobileDisplayMode)
              )
            }
            // Why: belt-and-suspenders cold-start fit. The applyFitScale
            // queued by init() runs after writes drain, but on cold start
            // xterm's scrollWidth can still be transient when it commits.
            // Re-fire after a short delay so it runs against a settled DOM.
            // Mirrors the 'resized' handler below.
            setTimeout(() => getTerminalRef(handle)?.resetZoom(), 200)
            // Why: viewport measurement needs xterm to be initialized (cell
            // dimensions come from the renderer). On the first subscribe the
            // WebView hasn't loaded yet, so viewportRef is null and the server
            // can't auto-fit. After the first init we can measure, then
            // resubscribe so the server gets the viewport and phone-fits.
            // If viewport was measured by a parallel path BUT the scrollback
            // we just received came back at desktop dims, our subscribe
            // beat the measure; the server still has a null viewport for
            // this subscriber record — resubscribe so it gets stored.
            const needsResubscribe =
              !viewportMeasuredRef.current ||
              (viewportRef.current != null &&
                (scrollbackCols !== viewportRef.current.cols ||
                  scrollbackRows !== viewportRef.current.rows))
            if (needsResubscribe) {
              void (async () => {
                // Why: wait for the WebView's init() rAF chain to fully
                // run (term.open → renderService population → first
                // paint) before measuring. Without this, the measure
                // postMessage races ahead of init's async work and
                // returns null (term not ready / cells size 0), the
                // resubscribe never fires, and the server never gets
                // phone dims. See log dump 2026-05-06 confirming the
                // race + measure-result null pattern.
                await getTerminalRef(handle)?.awaitReady()
                if (subscribeSeqRef.current.get(handle) !== seq) return
                const dims = await getTerminalRef(handle)?.measureFitDimensions(
                  terminalFrameHeightRef.current || undefined
                )
                // Why: re-check seq after the awaits — awaitReady (up to
                // 3s) and measureFitDimensions can take hundreds of ms,
                // during which a newer subscribe cycle may have armed
                // its own subscription. Tearing it down here would reset
                // the freshly-armed initialized flag and re-subscribe a
                // stale generation.
                if (subscribeSeqRef.current.get(handle) !== seq) return
                if (!getTerminalRef(handle)) return
                // Why: we just got `scrollback` with cols=80 (server's
                // default fallback for null viewport). That means the
                // server-side subscriber record was registered before we
                // could send viewport. Even if `viewportMeasuredRef`
                // raced ahead via a parallel `measureViewportOnce`, the
                // server still has a null viewport for THIS subscriber
                // record — we MUST resubscribe so the server stores it.
                if (dims) {
                  viewportRef.current = dims
                  viewportMeasuredRef.current = true
                  unsubscribeTerminal(handle)
                  initializedHandlesRef.current.delete(handle)
                  subscribeToTerminal(handle)
                }
              })()
            }
          } else if (data.type === 'data') {
            // Why: log when data arrives but the WebView ref is missing
            // — this is the most likely cause of "blank but input works":
            // server stream is alive, sends flow, but writes are dropped
            // because the WebView ref disappeared (unmount mid-flight) or
            // the scrollback never landed (so xterm has no buffer).
            const dataRef = getTerminalRef(handle)
            if (!dataRef) {
              console.log('[fit][session] data DROPPED — no terminal ref', {
                handle: handle.slice(-8),
                chunkLen: typeof data.chunk === 'string' ? data.chunk.length : 0,
                initialized: initializedHandlesRef.current.has(handle)
              })
              return
            }
            if (!initializedHandlesRef.current.has(handle)) {
              console.log('[fit][session] data RECEIVED before scrollback', {
                handle: handle.slice(-8),
                chunkLen: typeof data.chunk === 'string' ? data.chunk.length : 0
              })
            }
            dataRef.write(data.chunk as string)
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
      // Why: 'phone' on the wire is an observation ("currently phone-fitted"),
      // not a setting. The toggle only ever requests 'auto' or 'desktop'.
      const next: 'auto' | 'desktop' =
        current === 'auto' || current === 'phone' ? 'desktop' : 'auto'
      toggleInFlightRef.current.add(handle)
      try {
        await client.sendRequest('terminal.setDisplayMode', {
          terminal: handle,
          mode: next,
          // Why: presence-lock take-floor signal — requesting 'auto' is the
          // explicit "I want to drive at phone dims" gesture.
          ...(deviceTokenRef.current
            ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
            : {}),
          // Why: late-bind viewport for terminals whose subscribe record
          // was registered before measurement landed. Without this the
          // server's stored viewport is null and auto toggles no-op.
          ...(viewportRef.current && next === 'auto' ? { viewport: viewportRef.current } : {})
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
  }, [client])

  // Why: only clear terminal cache on actual unmount. Running it whenever
  // `client` changes — including the initial null → real-client transition
  // from useHostClient's async open path — would unsubscribe terminals and
  // wipe xterm state mid-subscribe on a normal session-screen mount.
  useEffect(() => {
    return () => {
      clearTerminalCache()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        // (unsubscribeTerminal also clears layoutSeqRef for this handle.)
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
      // active terminal and no subscription is running. Await measure before
      // subscribe so the very first subscribe carries the viewport — without
      // this, subscribe(viewport=null) lands on the server first and the
      // post-scrollback measure path's resubscribe sees alreadyMeasured=true
      // (because measureViewportOnce won the race) and silently skips.
      if (handle === activeHandleRef.current && !terminalUnsubsRef.current.has(handle)) {
        void (async () => {
          await measureViewportOnce(handle)
          if (handle === activeHandleRef.current && !terminalUnsubsRef.current.has(handle)) {
            subscribeToTerminal(handle)
          }
        })()
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

  // Why: press-and-hold key repeat for keys flagged repeatable (arrows,
  // backspace, forward-delete). Matches iOS keyboard cadence: instant first
  // fire, then ~400ms before the second, then ~45ms between subsequent
  // repeats. Non-repeatable keys (Tab, Esc, Ctrl-*) intentionally fire once
  // because holding them is destructive or meaningless.
  const repeatTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const repeatIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Why: hold the latest handleAccessoryKey in a ref so the repeat interval
  // always invokes the current callback. Otherwise a held key keeps firing
  // through the callback captured when the interval started, which can route
  // bytes to a stale terminal/RPC client after a tab switch or reconnect
  // mid-hold.
  const handleAccessoryKeyRef = useRef(handleAccessoryKey)
  handleAccessoryKeyRef.current = handleAccessoryKey
  const stopAccessoryRepeat = useCallback(() => {
    if (repeatTimeoutRef.current) {
      clearTimeout(repeatTimeoutRef.current)
      repeatTimeoutRef.current = null
    }
    if (repeatIntervalRef.current) {
      clearInterval(repeatIntervalRef.current)
      repeatIntervalRef.current = null
    }
  }, [])
  const startAccessoryRepeat = useCallback(
    (bytes: string) => {
      stopAccessoryRepeat()
      repeatTimeoutRef.current = setTimeout(() => {
        repeatIntervalRef.current = setInterval(() => {
          void handleAccessoryKeyRef.current(bytes)
        }, 45)
      }, 400)
    },
    [stopAccessoryRepeat]
  )
  useEffect(() => {
    return () => stopAccessoryRepeat()
  }, [stopAccessoryRepeat])

  const showToast = useCallback((message: string, durationMs = 1200) => {
    setToastMessage(message)
    Animated.timing(toastOpacityRef.current, {
      toValue: 1,
      duration: 150,
      useNativeDriver: true
    }).start(() => {
      setTimeout(() => {
        Animated.timing(toastOpacityRef.current, {
          toValue: 0,
          duration: 200,
          useNativeDriver: true
        }).start(() => setToastMessage(null))
      }, durationMs)
    })
  }, [])

  const handleSelectionMode = useCallback((handle: string, active: boolean) => {
    if (handle !== activeHandleRef.current) return
    setSelectModeActive(active)
    if (active) Keyboard.dismiss()
  }, [])

  const handleSelectionCopy = useCallback(
    async (handle: string, text: string) => {
      if (handle !== activeHandleRef.current) return
      if (!text || text.length === 0) {
        terminalRefs.current.get(handle)?.cancelSelect()
        return
      }
      try {
        await Clipboard.setStringAsync(text)
        triggerSuccess()
        // Why: Android 13+ shows its own system "Copied to clipboard" toast on
        // every clipboard write, so our toast would be redundant; iOS shows
        // nothing on copy (it only banners on paste), so the in-app toast is
        // the only success signal there.
        if (Platform.OS === 'ios') showToast('Copied')
        terminalRefs.current.get(handle)?.cancelSelect()
      } catch (e) {
        triggerError()
        const err = e as { name?: string; message?: string }
        // eslint-disable-next-line no-console
        console.warn('[mobile-clip] setString failed', {
          name: err.name,
          message: err.message
        })
        showToast("Couldn't copy", 1500)
      }
    },
    [showToast]
  )

  const handleSelectionEvicted = useCallback(
    (handle: string) => {
      if (handle !== activeHandleRef.current) return
      // eslint-disable-next-line no-console
      console.warn('[mobile-clip] selection evicted')
      showToast('Selection cleared (scrolled out of buffer)', 1500)
      setSelectModeActive(false)
    },
    [showToast]
  )

  const handleModesChanged = useCallback((handle: string, modes: TerminalModes) => {
    ptyModesRef.current.set(handle, modes)
    initialModesSeenRef.current.add(handle)
  }, [])

  const handleHaptic = useCallback((kind: 'selection' | 'success' | 'error' | 'edge-bump') => {
    if (kind === 'selection') triggerSelection()
    else if (kind === 'success') triggerSuccess()
    else if (kind === 'error') triggerError()
    else if (kind === 'edge-bump') triggerEdgeBump()
  }, [])

  const handlePaste = useCallback(async () => {
    if (!client || !activeHandle || !canSend) return
    try {
      const text = await Clipboard.getStringAsync()
      if (text.length === 0) return
      const modes = ptyModesRef.current.get(activeHandle) || {
        bracketedPasteMode: false,
        altScreen: false
      }
      const wrap = modes.bracketedPasteMode && !modes.altScreen
      // Why: strip embedded bracketed-paste markers from clipboard text so a
      // malicious copy containing `\x1b[201~` can't terminate paste mode early
      // and have the trailing bytes interpreted as shell commands. Matches
      // xterm.js / iTerm2 behavior.
      // eslint-disable-next-line no-control-regex -- intentional bracketed-paste marker stripping
      const sanitized = wrap ? text.replace(/\x1b\[20[01]~/g, '') : text
      const payload = wrap ? `\x1b[200~${sanitized}\x1b[201~` : sanitized
      const wrappedBytes = new TextEncoder().encode(payload).byteLength
      if (wrappedBytes > 256 * 1024) {
        triggerError()
        // eslint-disable-next-line no-console
        console.warn('[mobile-clip] paste oversized', { wrappedBytes })
        showToast('Paste too large (max 256 KiB)', 1500)
        return
      }
      await client.sendRequest('terminal.send', {
        terminal: activeHandle,
        text: payload,
        enter: false,
        ...(deviceTokenRef.current
          ? { client: { id: deviceTokenRef.current, type: 'mobile' as const } }
          : {})
      })
      triggerSelection()
      void Clipboard.hasStringAsync().then(setCanPaste)
    } catch (e) {
      triggerError()
      const err = e as { name?: string; message?: string }
      const isDisconnected = connState !== 'connected'
      // eslint-disable-next-line no-console
      console.warn('[mobile-clip] paste failed', { name: err.name, message: err.message })
      if (isDisconnected) showToast('Paste failed (disconnected)', 1500)
    }
  }, [client, activeHandle, canSend, connState, showToast])

  // Why: refresh canPaste on mount, AppState active, after paste.
  useEffect(() => {
    let mounted = true
    const refresh = () => {
      void Clipboard.hasStringAsync().then((has) => {
        if (mounted) setCanPaste(has)
      })
    }
    refresh()
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') refresh()
      else if (selectModeActive && activeHandleRef.current) {
        terminalRefs.current.get(activeHandleRef.current)?.cancelSelect()
      }
    })
    return () => {
      mounted = false
      sub.remove()
    }
  }, [selectModeActive])

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
                onSelectionMode={handleSelectionMode}
                onSelectionCopy={handleSelectionCopy}
                onSelectionEvicted={handleSelectionEvicted}
                onModesChanged={handleModesChanged}
                onHaptic={handleHaptic}
              />
            ))}
            {toastMessage && (
              <Animated.View
                pointerEvents="none"
                style={[styles.toast, { opacity: toastOpacityRef.current }]}
              >
                <Text style={styles.toastText}>{toastMessage}</Text>
              </Animated.View>
            )}
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
              {canPaste && (
                <Pressable
                  style={({ pressed }) => [
                    styles.accessoryKey,
                    pressed && styles.accessoryKeyPressed,
                    !canSend && styles.accessoryKeyDisabled
                  ]}
                  disabled={!canSend}
                  onPress={() => void handlePaste()}
                  accessibilityLabel="Paste from clipboard"
                >
                  <Text
                    style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}
                  >
                    Paste
                  </Text>
                </Pressable>
              )}
              {ACCESSORY_KEYS.map((key) => (
                <Pressable
                  key={key.label}
                  style={({ pressed }) => [
                    styles.accessoryKey,
                    pressed && styles.accessoryKeyPressed,
                    !canSend && styles.accessoryKeyDisabled
                  ]}
                  disabled={!canSend}
                  onPressIn={() => {
                    if (!key.repeatable) return
                    void handleAccessoryKey(key.bytes)
                    startAccessoryRepeat(key.bytes)
                  }}
                  onPressOut={() => {
                    if (key.repeatable) stopAccessoryRepeat()
                  }}
                  onPress={() => {
                    if (key.repeatable) return
                    void handleAccessoryKey(key.bytes)
                  }}
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
  toast: {
    position: 'absolute',
    bottom: spacing.lg,
    alignSelf: 'center',
    left: 0,
    right: 0,
    alignItems: 'center'
  },
  toastText: {
    backgroundColor: 'rgba(20, 22, 39, 0.92)',
    color: colors.textPrimary,
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    overflow: 'hidden'
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
