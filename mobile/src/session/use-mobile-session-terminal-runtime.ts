import { useState, useRef, useCallback } from 'react'
import type { Keyboard, TextInput } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { TerminalModes, TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import { useTerminalLiveInputFocus } from '../terminal/use-terminal-live-input-focus'
import type { TerminalLiveInputSender } from '../terminal/terminal-live-input-sender'
import { useTerminalLiveInputCommit } from '../terminal/use-terminal-live-input-commit'
import { resolveMobileTerminalInputGate } from '../terminal/terminal-input-connection-gate'
import { createInitialSessionAutoCreateState } from './use-initial-session-terminal-autocreate'
import { TerminalViewportResubscribeBudget } from './mobile-terminal-viewport-resubscribe'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import { useBufferedTerminalDrafts } from '../terminal/use-buffered-terminal-drafts'
import { useMobileTerminalInventoryRecoveryBridge } from './use-mobile-terminal-inventory-recovery'
import type {
  MobileSessionTab,
  MobileSessionTabType,
  TerminalGestureInputBucket,
  TerminalGestureInputQueue
} from './mobile-session-route-types'
import type { MobileSessionScreenStateModel } from './use-mobile-session-screen-state'

export function useMobileSessionTerminalRuntime(scope: MobileSessionScreenStateModel) {
  const {
    hostId,
    worktreeId,
    connState,
    client,
    sessionTabs,
    setLiveInputCapture,
    liveInputTerminalHandles,
    liveInputTerminalHandlesRef,
    activeHandle,
    activeSessionTabId,
    keyboardHeight
  } = scope
  // Why: WebView pushes terminal modes on every change so paste reads a synchronous snapshot — no round-trip.
  const ptyModesRef = useRef<Map<string, TerminalModes>>(new Map())
  const terminalGestureInputBucketsRef = useRef<Map<string, TerminalGestureInputBucket>>(new Map())
  const terminalGestureInputQueuesRef = useRef<Map<string, TerminalGestureInputQueue>>(new Map())
  const terminalGestureInputInFlightRef = useRef<Set<string>>(new Set())
  const terminalCwdRef = useRef<Map<string, string>>(new Map())
  const initialModesSeenRef = useRef<Set<string>>(new Set())
  const deviceTokenRef = useRef<string | null>(null)
  // Why: state (not a ref) so the connection verdict re-renders when the endpoint loads and the Tailscale hint can appear.
  const [hostEndpoint, setHostEndpoint] = useState<string | null>(null)
  const clientRef = useRef<RpcClient | null>(null)
  const connStateRef = useRef<ConnectionState>(connState)
  // Why: measured once on mount, then passed with every subscribe so the server can auto-fit the PTY to phone dims.
  const viewportRef = useRef<{ cols: number; rows: number } | null>(null)
  const viewportMeasuredRef = useRef(false)
  const terminalRefs = useRef<Map<string, TerminalWebViewHandle>>(new Map())
  const liveInputRef = useRef<TextInput>(null)
  const commandInputRef = useRef<TextInput>(null)
  const liveInputFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendLiveTerminalInputRef = useRef<TerminalLiveInputSender>(async () => false)
  const sessionTabActionSheetKeyboardHideSubRef = useRef<ReturnType<
    typeof Keyboard.addListener
  > | null>(null)
  const sessionTabActionSheetRequestSeqRef = useRef(0)
  const dictationRouteContextRef = useRef<{
    readonly handle: string | null
    readonly liveInputEnabled: boolean
  } | null>(null)
  const terminalUnsubsRef = useRef<Map<string, () => void>>(new Map())
  const subscribingHandlesRef = useRef<Set<string>>(new Set())
  // Lease-only streams do not render, so reconciliation tracks them separately.
  const leaseOnlyHandlesRef = useRef<Set<string>>(new Set())
  const initializedHandlesRef = useRef<Set<string>>(new Set())
  const terminalDiagnosticsRef = useRef(new MobileTerminalDiagnostics())
  // Why: bounds the scrollback→resubscribe fit loop per handle (STA-3337).
  const viewportResubscribeBudgetRef = useRef(new TerminalViewportResubscribeBudget())
  // Why: don't subscribe until the WebView fires web-ready — iOS may defer JS in hidden WebViews and init() messages would queue unrendered.
  const webReadyHandlesRef = useRef<Set<string>>(new Set())
  const activeHandleRef = useRef<string | null>(null)
  const bufferedTerminalDraftState = useBufferedTerminalDrafts({ activeHandle, activeHandleRef })
  const reconcileBufferedDraftsRef = useRef(bufferedTerminalDraftState.reconcileTerminalTabs)
  const activeSessionTabTypeRef = useRef<MobileSessionTabType | null>(null)
  const pendingActiveSessionTabIdRef = useRef<string | null>(null)
  const pendingActiveTerminalHandleRef = useRef<string | null>(null)
  // Why: remember the page id to activate its session tab once it syncs (bridge auto-activate flags only webContents, not the app-level active tab).
  const pendingBrowserFocusPageIdRef = useRef<string | null>(null)
  const switchSessionTabRef = useRef<((tab: MobileSessionTab) => void) | null>(null)
  const pendingTerminalActivationAttemptRef = useRef<string | null>(null)
  // Why: route the terminal URL tap through a ref so it runs the current handleCreateBrowser closure (the memoized one may hold a null-client render).
  const handleCreateBrowserRef = useRef<((rawUrl?: string) => Promise<boolean>) | null>(null)
  const terminalInventoryRecoveryScope = JSON.stringify([hostId, worktreeId])
  const { registerTerminalInventoryRecoveryAction, signalTerminalInventoryRecovery } =
    useMobileTerminalInventoryRecoveryBridge(terminalInventoryRecoveryScope)

  const initialSessionAutoCreateRef = useRef(createInitialSessionAutoCreateState())
  const markdownSaveSeqRef = useRef<Map<string, number>>(new Map())
  const markdownSaveInFlightRef = useRef<Set<string>>(new Set())
  const subscribeSeqRef = useRef<Map<string, number>>(new Map())
  // Why: post-RPC refresh timers capture this screen and must not survive route reuse or unmount.
  const delayedActionTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  // Why: highest applyLayout seq seen per handle; drop older scrollback/resized as stale, but a >20 gap resets (fresh subscription/server restart).
  const layoutSeqRef = useRef<Map<string, number>>(new Map())
  const sendingRef = useRef(false)
  // Why: exact terminal-frame height for measureFitDimensions; window.innerHeight can overstate the visible area.
  const terminalFrameHeightRef = useRef<number>(0)
  // Why: sidebar resizes change the terminal frame width without a window-dim change; track it so the refit hook re-fits (see terminal-viewport-refit.ts).
  const [terminalFrameWidth, setTerminalFrameWidth] = useState(0)
  const activeSessionTab = sessionTabs.find((tab) => tab.id === activeSessionTabId) ?? null
  const {
    clearPendingLiveInputCommit,
    flushPendingLiveInputBeforeExternalSend,
    getLiveInputInteractionGeneration,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSubmit
  } = useTerminalLiveInputCommit({
    activeHandle,
    activeHandleRef,
    activeSessionTabType: activeSessionTab?.type,
    activeSessionTabTypeRef,
    connected: connState === 'connected',
    liveInputRef,
    liveInputTerminalHandles,
    liveInputTerminalHandlesRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture
  })
  const { canCompose, canSend } = resolveMobileTerminalInputGate({
    connState,
    activeHandle,
    activeSessionTabType: activeSessionTab?.type
  })
  const liveInputEnabled = activeHandle ? liveInputTerminalHandles.has(activeHandle) : false
  const { focusLiveInput, handleTerminalTap, resetLiveInputFocus } = useTerminalLiveInputFocus({
    activeHandleRef,
    canSend,
    inputRef: liveInputRef,
    keyboardHeight,
    lifecycleIdentity: client,
    lifecycleKey: JSON.stringify([hostId, worktreeId, connState]),
    liveInputEnabled,
    timerRef: liveInputFocusTimerRef
  })
  useFocusEffect(
    useCallback(() => {
      // Expo retains this route while pushed screens are visible.
      return resetLiveInputFocus
    }, [resetLiveInputFocus])
  )
  return {
    ptyModesRef,
    terminalGestureInputBucketsRef,
    terminalGestureInputQueuesRef,
    terminalGestureInputInFlightRef,
    terminalCwdRef,
    initialModesSeenRef,
    deviceTokenRef,
    hostEndpoint,
    setHostEndpoint,
    clientRef,
    connStateRef,
    viewportRef,
    viewportMeasuredRef,
    terminalRefs,
    liveInputRef,
    commandInputRef,
    liveInputFocusTimerRef,
    sendLiveTerminalInputRef,
    sessionTabActionSheetKeyboardHideSubRef,
    sessionTabActionSheetRequestSeqRef,
    dictationRouteContextRef,
    terminalUnsubsRef,
    subscribingHandlesRef,
    leaseOnlyHandlesRef,
    initializedHandlesRef,
    terminalDiagnosticsRef,
    viewportResubscribeBudgetRef,
    webReadyHandlesRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingActiveSessionTabIdRef,
    pendingActiveTerminalHandleRef,
    pendingBrowserFocusPageIdRef,
    switchSessionTabRef,
    pendingTerminalActivationAttemptRef,
    handleCreateBrowserRef,
    initialSessionAutoCreateRef,
    markdownSaveSeqRef,
    markdownSaveInFlightRef,
    subscribeSeqRef,
    delayedActionTimersRef,
    layoutSeqRef,
    sendingRef,
    terminalFrameHeightRef,
    terminalFrameWidth,
    setTerminalFrameWidth,
    activeSessionTab,
    clearPendingLiveInputCommit,
    flushPendingLiveInputBeforeExternalSend,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSubmit,
    canCompose,
    canSend,
    liveInputEnabled,
    focusLiveInput,
    handleTerminalTap,
    resetLiveInputFocus,
    terminalInventoryRecoveryScope,
    registerTerminalInventoryRecoveryAction,
    signalTerminalInventoryRecovery,
    bufferedTerminalDraftState,
    reconcileBufferedDraftsRef,
    input: bufferedTerminalDraftState.input,
    setInput: bufferedTerminalDraftState.setInput,
    getLiveInteractionGeneration: getLiveInputInteractionGeneration
  }
}

export type MobileSessionTerminalRuntimeModel = MobileSessionScreenStateModel &
  ReturnType<typeof useMobileSessionTerminalRuntime>
