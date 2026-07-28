import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TerminalEditorTransaction } from '@orca/expo-terminal-live-input'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import {
  applyTerminalEditorTransaction,
  createTerminalEditorTransactionState,
  flushTerminalEditorTransaction,
  type TerminalEditorTransactionState
} from './terminal-editor-transaction-reconciler'
import type { TerminalLiveInputCaptureHandle } from './terminal-live-input-capture-handle'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import {
  getTerminalLiveAccessoryBytesDecision,
  getTerminalLiveAccessoryLocalEditText,
  getTerminalLiveSpecialKeyDecision
} from './terminal-live-text-commit'
import type { TerminalLiveAccessoryInputCommitResult } from './use-terminal-live-accessory-input-commit'

type TerminalRevisionedInputOptions<TTabType extends string> = {
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabType: TTabType | null | undefined
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly liveInputRef: RefObject<TerminalLiveInputCaptureHandle | null>
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly liveInputTerminalHandlesRef: RefObject<Set<string>>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

export type TerminalRevisionedInputHandlers = {
  readonly clearPendingLiveInputCommit: () => void
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly handleLiveInputAccessoryBytes: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly handleLiveInputKeyPress: (event: { nativeEvent: { key: string } }) => void
  readonly handleLiveInputSubmit: () => void
  readonly handleTerminalEditorTransaction: (transaction: TerminalEditorTransaction) => void
}

export function useTerminalRevisionedInputCommit<TTabType extends string>({
  activeHandle,
  activeHandleRef,
  activeSessionTabType,
  activeSessionTabTypeRef,
  liveInputRef,
  liveInputTerminalHandles,
  liveInputTerminalHandlesRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalRevisionedInputOptions<TTabType>): TerminalRevisionedInputHandlers {
  const stateRef = useRef<TerminalEditorTransactionState>(createTerminalEditorTransactionState())
  const pendingHandleRef = useRef<string | null>(null)
  const pendingSendRef = useRef<Promise<boolean> | null>(null)

  const clearPendingLiveInputCommit = useCallback(() => {
    stateRef.current = createTerminalEditorTransactionState()
    pendingHandleRef.current = null
    setLiveInputCapture('')
    liveInputRef.current?.setNativeProps({ text: '' })
  }, [liveInputRef, setLiveInputCapture])

  const isCurrentTerminal = useCallback(
    (handle: string): boolean =>
      handle === activeHandleRef.current &&
      (activeSessionTabTypeRef.current == null || activeSessionTabTypeRef.current === 'terminal') &&
      liveInputTerminalHandlesRef.current.has(handle),
    [activeHandleRef, activeSessionTabTypeRef, liveInputTerminalHandlesRef]
  )

  const sendBytes = useCallback(
    (handle: string, bytes: string): Promise<boolean> => {
      if (bytes.length === 0) {
        return pendingSendRef.current ?? Promise.resolve(true)
      }
      const pending = sendLiveTerminalInputRef.current(handle, bytes).catch(() => false)
      pendingSendRef.current = pending
      void pending.then((accepted) => {
        if (!accepted && pendingSendRef.current === pending) {
          clearPendingLiveInputCommit()
        }
        if (pendingSendRef.current === pending) {
          pendingSendRef.current = null
        }
      })
      return pending
    },
    [clearPendingLiveInputCommit, sendLiveTerminalInputRef]
  )

  const applyTransaction = useCallback(
    (handle: string, transaction: TerminalEditorTransaction): Promise<boolean> => {
      if (!isCurrentTerminal(handle)) {
        clearPendingLiveInputCommit()
        return Promise.resolve(false)
      }
      if (pendingHandleRef.current !== handle) {
        stateRef.current = createTerminalEditorTransactionState()
      }
      const result = applyTerminalEditorTransaction(stateRef.current, transaction)
      stateRef.current = result.state
      pendingHandleRef.current = handle
      setLiveInputCapture(transaction.text)
      return sendBytes(handle, result.bytes)
    },
    [clearPendingLiveInputCommit, isCurrentTerminal, sendBytes, setLiveInputCapture]
  )

  const flushPendingText = useCallback(
    async (expectedHandle: string): Promise<boolean> => {
      if (pendingHandleRef.current !== expectedHandle) {
        return pendingSendRef.current ?? true
      }
      const result = flushTerminalEditorTransaction(stateRef.current)
      stateRef.current = result.state
      const accepted = await sendBytes(expectedHandle, result.bytes)
      if (
        accepted &&
        pendingHandleRef.current === expectedHandle &&
        stateRef.current === result.state
      ) {
        clearPendingLiveInputCommit()
      }
      return accepted
    },
    [clearPendingLiveInputCommit, sendBytes]
  )

  const handleTerminalEditorTransaction = useCallback(
    (transaction: TerminalEditorTransaction) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        clearPendingLiveInputCommit()
        return
      }
      void applyTransaction(activeHandle, transaction)
    },
    [activeHandle, applyTransaction, clearPendingLiveInputCommit, liveInputTerminalHandles]
  )

  const handleLiveInputKeyPress = useCallback(
    (event: { nativeEvent: { key: string } }) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      const state =
        pendingHandleRef.current === activeHandle
          ? stateRef.current
          : createTerminalEditorTransactionState()
      const heldText = state.editorText.startsWith(state.terminalText)
        ? state.editorText.slice(state.terminalText.length)
        : ''
      const decision = getTerminalLiveSpecialKeyDecision({
        key: event.nativeEvent.key,
        heldText,
        sentText: state.terminalText
      })
      if (decision.kind === 'send-now') {
        void sendBytes(activeHandle, decision.bytes)
      } else if (decision.kind === 'commit-held-then-send') {
        void flushPendingText(activeHandle).then((accepted) =>
          accepted ? sendBytes(activeHandle, decision.bytes) : false
        )
      }
    },
    [activeHandle, flushPendingText, liveInputTerminalHandles, sendBytes]
  )

  const handleLiveInputAccessoryBytes = useCallback(
    async (input: TerminalLiveAccessoryInput): Promise<TerminalLiveAccessoryInputCommitResult> => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        return { kind: 'allow-raw' }
      }
      const state =
        pendingHandleRef.current === activeHandle
          ? stateRef.current
          : createTerminalEditorTransactionState()
      const heldText = state.editorText.startsWith(state.terminalText)
        ? state.editorText.slice(state.terminalText.length)
        : ''
      const decision = getTerminalLiveAccessoryBytesDecision({
        ...input,
        heldText,
        sentText: state.terminalText
      })
      if (decision.kind === 'send-now') {
        return (await (pendingSendRef.current ?? Promise.resolve(true)))
          ? { kind: 'allow-raw' }
          : { kind: 'suppress-raw' }
      }
      if (decision.kind === 'commit-held-then-send') {
        const flushed = await flushPendingText(activeHandle)
        if (flushed) {
          await sendBytes(activeHandle, decision.bytes)
        }
        return { kind: 'handled' }
      }
      const text = getTerminalLiveAccessoryLocalEditText({
        localEdit: decision.localEdit,
        fieldText: state.editorText
      })
      liveInputRef.current?.setNativeProps({ text })
      await applyTransaction(activeHandle, {
        revision: state.revision + 1,
        text,
        composingStart: null,
        composingEnd: null
      })
      return { kind: 'handled' }
    },
    [
      activeHandle,
      applyTransaction,
      flushPendingText,
      liveInputRef,
      liveInputTerminalHandles,
      sendBytes
    ]
  )

  const handleLiveInputSubmit = useCallback(() => {
    if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
      return
    }
    void flushPendingText(activeHandle).then((accepted) =>
      accepted ? sendBytes(activeHandle, '\r') : false
    )
  }, [activeHandle, flushPendingText, liveInputTerminalHandles, sendBytes])

  useEffect(() => {
    const pendingHandle = pendingHandleRef.current
    if (
      pendingHandle &&
      (!activeHandle ||
        pendingHandle !== activeHandle ||
        (activeSessionTabType != null && activeSessionTabType !== 'terminal') ||
        !liveInputTerminalHandles.has(activeHandle))
    ) {
      clearPendingLiveInputCommit()
    }
  }, [activeHandle, activeSessionTabType, clearPendingLiveInputCommit, liveInputTerminalHandles])

  return {
    clearPendingLiveInputCommit,
    flushPendingLiveInputBeforeExternalSend: flushPendingText,
    handleLiveInputAccessoryBytes,
    handleLiveInputKeyPress,
    handleLiveInputSubmit,
    handleTerminalEditorTransaction
  }
}
