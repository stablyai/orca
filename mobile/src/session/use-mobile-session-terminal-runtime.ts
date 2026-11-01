import {
  terminalPaneViewport,
  resolveTerminalPaneHandles,
  type TerminalPaneViewport
} from './mobile-terminal-pane-layout'
import type { PendingSessionSelection } from './pending-session-selection'
import { useState, useRef, useCallback } from 'react'
import type { TerminalFrame } from '../terminal/terminal-webview-messages'
import { Alert, type Keyboard, type TextInput } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import type { TerminalModes, TerminalWebViewHandle } from '../terminal/terminal-webview-contract'
import { useTerminalLiveInputFocus } from '../terminal/use-terminal-live-input-focus'
import { reopensFocusedInputWhenKeyboardHidden } from '../terminal/terminal-live-input-keyboard-reopen'
import type { TerminalLiveInputSender } from '../terminal/terminal-live-input-sender'
import type { TerminalLiveInputFailure } from '../terminal/terminal-live-pending-flush-state'
import { useTerminalLiveInputCommit } from '../terminal/use-terminal-live-input-commit'
import { resolveMobileTerminalInputGate } from '../terminal/terminal-input-connection-gate'
import { createInitialSessionAutoCreateState } from './use-initial-session-terminal-autocreate'
import { TerminalViewportResubscribeBudget } from './mobile-terminal-viewport-resubscribe'
import { MobileTerminalDiagnostics } from './mobile-terminal-diagnostics'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useBufferedTerminalDrafts } from '../terminal/use-buffered-terminal-drafts'
import { useMobileTerminalInventoryRecoveryBridge } from './use-mobile-terminal-inventory-recovery'
import type {
  MobileSessionTab,
  MobileSessionTabType,
  TerminalGestureInputBucket,
  TerminalGestureInputQueue
} from './mobile-session-route-types'
import type { MobileSessionScreenStateModel } from './use-mobile-session-screen-state'
import type { MobileDictationAnchor } from '../dictation/mobile-dictation-text-insertion'

export function useMobileSessionTerminalRuntime(scope: MobileSessionScreenStateModel) {
  const {
    hostId,
    worktreeId,
    connState,
    client,
    clientId,
    sessionTabs,
    terminals,
    setLiveInputCapture,
    liveInputTerminalHandles,
    liveInputTerminalHandlesRef,
    activeHandle,
    activeSessionTabId,
    keyboardHeight
  } = scope
  // Keep pushed terminal modes synchronous for paste without another round trip.
  const ptyModesRef = useRef<Map<string, TerminalModes>>(new Map())
  const terminalGestureInputBucketsRef = useRef<Map<string, TerminalGestureInputBucket>>(new Map())
  const terminalGestureInputQueuesRef = useRef<Map<string, TerminalGestureInputQueue>>(new Map())
  const terminalGestureInputInFlightRef = useRef<Set<string>>(new Set())
  const terminalCwdRef = useRef<Map<string, string>>(new Map())
  const initialModesSeenRef = useRef<Set<string>>(new Set())
  const deviceTokenRef = useRef<string | null>(clientId)
  deviceTokenRef.current = clientId
  // Use state so loaded endpoint hints trigger a render.
  const [hostEndpoint, setHostEndpoint] = useState<string | null>(null)
  const [hostName, setHostName] = useState<string | null>(null)
  const clientRef = useRef<RpcClient | null>(null)
  const connStateRef = useRef<ConnectionState>(connState)
  // Carry measured phone dimensions on subscribes so the host fits before snapshot serialization.
  const viewportRef = useRef<{ cols: number; rows: number } | null>(null)
  const viewportMeasuredRef = useRef(false)
  const terminalPaneViewportsRef = useRef(new Map<string, TerminalPaneViewport>())
  const getTerminalPaneViewport = useCallback(
    (handle: string) => terminalPaneViewport(terminalPaneViewportsRef.current, handle),
    []
  )
  const [splitTerminalHandles, setSplitTerminalHandles] = useState<readonly string[] | null>(null)
  const visibleTerminalHandles = resolveTerminalPaneHandles(
    activeHandle,
    splitTerminalHandles,
    terminals.map((terminal) => terminal.handle)
  )
  // The controller publishes the committed list, once native chat has had its say.
  const visibleTerminalHandlesRef = useRef<readonly string[]>(visibleTerminalHandles)
  const terminalRefs = useRef<Map<string, TerminalWebViewHandle>>(new Map())
  const liveInputRef = useRef<TextInput>(null)
  const commandInputRef = useRef<TextInput>(null)
  const liveInputFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendLiveTerminalInputRef = useRef<TerminalLiveInputSender>(async () => false)
  const onLiveInputSendFailureRef = useRef<(failure: TerminalLiveInputFailure) => void>(() => {})
  const handleLiveInputSendFailure = useCallback((failure: TerminalLiveInputFailure) => {
    onLiveInputSendFailureRef.current(failure)
  }, [])
  const sessionTabActionSheetKeyboardHideSubRef = useRef<ReturnType<
    typeof Keyboard.addListener
  > | null>(null)
  const sessionTabActionSheetRequestSeqRef = useRef(0)
  const dictationRouteContextRef = useRef<{
    readonly handle: string | null
    readonly liveInputEnabled: boolean
    readonly anchor: MobileDictationAnchor | null
  } | null>(null)
  // Terminals share one command field, so its selection names the terminal it was read in.
  const commandFieldAnchorRef = useRef<{
    readonly handle: string | null
    readonly anchor: MobileDictationAnchor
  } | null>(null)
  const terminalUnsubsRef = useRef<Map<string, () => void>>(new Map())
  const subscribingHandlesRef = useRef<Set<string>>(new Set())
  const leaseOnlyHandlesRef = useRef<Set<string>>(new Set())
  const initializedHandlesRef = useRef<Set<string>>(new Set())
  const terminalDiagnosticsRef = useRef(new MobileTerminalDiagnostics())
  const viewportResubscribeBudgetRef = useRef(new TerminalViewportResubscribeBudget())
  // Wait for web-ready: hidden iOS WebViews can defer JS and otherwise queue init before rendering.
  const webReadyHandlesRef = useRef<Set<string>>(new Set())
  const activeHandleRef = useRef<string | null>(null)
  const executionHost = useWorkspaceExecutionHost()
  const bufferedTerminalDraftState = useBufferedTerminalDrafts({
    activeHandle,
    activeHandleRef,
    storageKey:
      hostId && worktreeId
        ? `orca:terminalDrafts:${encodeURIComponent(hostId)}:${encodeURIComponent(worktreeId)}`
        : undefined,
    storageScope: executionHost,
    onStorageError: () =>
      Alert.alert(
        'Draft could not be saved',
        'Keep this screen open to avoid losing the command draft.'
      )
  })
  const reconcileBufferedDraftsRef = useRef(bufferedTerminalDraftState.reconcileTerminalTabs)
  const activeSessionTabTypeRef = useRef<MobileSessionTabType | null>(null)
  const pendingSelectionRef = useRef<PendingSessionSelection | null>(null)
  const pendingBrowserFocusPageIdRef = useRef<string | null>(null)
  const switchSessionTabRef = useRef<((tab: MobileSessionTab) => void) | null>(null)
  const pendingTerminalActivationAttemptRef = useRef<string | null>(null)
  const handleCreateBrowserRef = useRef<((rawUrl?: string) => Promise<boolean>) | null>(null)
  const terminalInventoryRecoveryScope = JSON.stringify([hostId, worktreeId])
  const { registerTerminalInventoryRecoveryAction, signalTerminalInventoryRecovery } =
    useMobileTerminalInventoryRecoveryBridge(terminalInventoryRecoveryScope)

  const initialSessionAutoCreateRef = useRef(createInitialSessionAutoCreateState())
  const markdownSaveSeqRef = useRef<Map<string, number>>(new Map())
  const markdownSaveInFlightRef = useRef<Set<string>>(new Set())
  const subscribeSeqRef = useRef<Map<string, number>>(new Map())
  const delayedActionTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  // Reject stale layout sequences; large gaps reset the mark for fresh subscriptions/server restarts.
  const layoutSeqRef = useRef<Map<string, number>>(new Map())
  const sendingRef = useRef(false)
  // Fit the unrounded measured frame; window height can exceed visible area.
  const terminalFrameRef = useRef<TerminalFrame | null>(null)
  const activeSessionTab = sessionTabs.find((tab) => tab.id === activeSessionTabId) ?? null
  const framesLivePaste = useCallback(
    (handle: string): boolean => ptyModesRef.current.get(handle)?.bracketedPasteMode === true,
    []
  )
  const {
    clearPendingLiveInputCommit,
    flushPendingLiveInputBeforeExternalSend,
    getLiveInputInteractionGeneration,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSubmit,
    sendLiveInputClick
  } = useTerminalLiveInputCommit({
    activeHandle,
    activeHandleRef,
    activeSessionTabType: activeSessionTab?.type,
    activeSessionTabTypeRef,
    framesLivePaste,
    onSendFailure: handleLiveInputSendFailure,
    connected: connState === 'connected',
    liveInputRef,
    liveInputTerminalHandles,
    liveInputTerminalHandlesRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture
  })
  const inputGate = resolveMobileTerminalInputGate({
    connState,
    activeHandle,
    activeSessionTabType: activeSessionTab?.type
  })
  const canCompose = inputGate.canCompose
  const canSend = inputGate.canSend && clientId !== null
  const liveInputEnabled = activeHandle ? liveInputTerminalHandles.has(activeHandle) : false
  const { handleTerminalTap, resetLiveInputFocus } = useTerminalLiveInputFocus({
    activeHandleRef,
    canSend,
    commandInputRef,
    inputRef: liveInputRef,
    keyboardHeight,
    lifecycleIdentity: client,
    lifecycleKey: JSON.stringify([hostId, worktreeId, connState]),
    liveInputEnabled,
    reopenFocusedInputWhenKeyboardHidden: reopensFocusedInputWhenKeyboardHidden(),
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
    hostName,
    setHostName,
    clientRef,
    connStateRef,
    viewportRef,
    viewportMeasuredRef,
    terminalPaneViewportsRef,
    getTerminalPaneViewport,
    splitTerminalHandles,
    setSplitTerminalHandles,
    visibleTerminalHandles,
    visibleTerminalHandlesRef,
    terminalRefs,
    liveInputRef,
    commandInputRef,
    liveInputFocusTimerRef,
    sendLiveTerminalInputRef,
    onLiveInputSendFailureRef,
    sessionTabActionSheetKeyboardHideSubRef,
    sessionTabActionSheetRequestSeqRef,
    dictationRouteContextRef,
    commandFieldAnchorRef,
    terminalUnsubsRef,
    subscribingHandlesRef,
    leaseOnlyHandlesRef,
    initializedHandlesRef,
    terminalDiagnosticsRef,
    viewportResubscribeBudgetRef,
    webReadyHandlesRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    pendingSelectionRef,
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
    terminalFrameRef,
    activeSessionTab,
    clearPendingLiveInputCommit,
    flushPendingLiveInputBeforeExternalSend,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSubmit,
    sendLiveInputClick,
    canCompose,
    canSend,
    liveInputEnabled,
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
