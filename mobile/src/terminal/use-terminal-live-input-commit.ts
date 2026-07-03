import { useCallback, useEffect, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import {
  getTerminalLiveSpecialKeyDecision,
  getTerminalLiveSubmitSequence,
  getTerminalLiveTextChangeDecision
} from './terminal-live-text-commit'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'
import { useTerminalLivePendingInputFlush } from './use-terminal-live-pending-input-flush'
import {
  useTerminalLiveAccessoryInputCommit,
  type TerminalLiveAccessoryInputCommitResult
} from './use-terminal-live-accessory-input-commit'

type TerminalLiveInputKeyPressEvent = {
  readonly nativeEvent: {
    readonly key: string
  }
}

type TerminalLiveInputCommitOptions<TTabType extends string> = {
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabType: TTabType | null | undefined
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly liveInputTerminalHandlesRef: RefObject<Set<string>>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

type TerminalLiveInputCommitHandlers = {
  readonly clearPendingLiveInputCommit: () => void
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly handleLiveInputAccessoryBytes: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly handleLiveInputChange: (text: string) => void
  readonly handleLiveInputKeyPress: (event: TerminalLiveInputKeyPressEvent) => void
  readonly handleLiveInputSubmit: () => void
}

export function useTerminalLiveInputCommit<TTabType extends string>({
  activeHandle,
  activeHandleRef,
  activeSessionTabType,
  activeSessionTabTypeRef,
  liveInputRef,
  liveInputTerminalHandles,
  liveInputTerminalHandlesRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLiveInputCommitOptions<TTabType>): TerminalLiveInputCommitHandlers {
  const {
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    pendingLiveInputHandleRef,
    pendingLiveInputTextRef,
    schedulePendingLiveInputCommit,
    waitForPendingLiveInputFlush
  } = useTerminalLivePendingInputFlush({
    activeHandleRef,
    activeSessionTabTypeRef,
    liveInputRef,
    liveInputTerminalHandlesRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture
  })

  useEffect(() => {
    const pendingHandle = pendingLiveInputHandleRef.current
    if (!pendingHandle) {
      return
    }
    if (
      !activeHandle ||
      pendingHandle !== activeHandle ||
      activeSessionTabType !== 'terminal' ||
      !liveInputTerminalHandles.has(activeHandle)
    ) {
      clearPendingLiveInputCommit()
    }
  }, [activeHandle, activeSessionTabType, clearPendingLiveInputCommit, liveInputTerminalHandles])

  const flushPendingLiveInputBeforeExternalSend = useCallback(
    async (handle: string): Promise<boolean> => {
      const pendingHandle = pendingLiveInputHandleRef.current
      if (pendingHandle && pendingHandle !== handle) {
        clearPendingLiveInputCommit()
        return waitForPendingLiveInputFlush()
      }
      if (pendingHandle === handle && pendingLiveInputTextRef.current.length > 0) {
        return flushPendingLiveInputText(handle)
      }
      return waitForPendingLiveInputFlush()
    },
    [clearPendingLiveInputCommit, flushPendingLiveInputText, waitForPendingLiveInputFlush]
  )

  const handleLiveInputChange = useCallback(
    (text: string) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        clearPendingLiveInputCommit()
        return
      }
      const normalizedText = normalizeTerminalTextInput(text)
      const decision = getTerminalLiveTextChangeDecision(normalizedText)
      switch (decision.kind) {
        case 'ignore':
          clearPendingLiveInputCommit()
          return
        case 'send-now':
          clearPendingLiveInputCommit()
          void sendTerminalLiveControlAfterPendingFlush(waitForPendingLiveInputFlush, () =>
            sendLiveTerminalInputRef.current(activeHandle, decision.text)
          )
          return
        case 'defer':
          // Why: React Native does not expose composition events here, so keep
          // probable IME text in the native field until the commit timer settles.
          setLiveInputCapture(decision.text)
          schedulePendingLiveInputCommit(activeHandle, decision.text, decision.delayMs)
          return
        default:
          decision satisfies never
      }
    },
    [
      activeHandle,
      clearPendingLiveInputCommit,
      liveInputTerminalHandles,
      schedulePendingLiveInputCommit,
      sendLiveTerminalInputRef,
      setLiveInputCapture,
      waitForPendingLiveInputFlush
    ]
  )

  const handleLiveInputKeyPress = useCallback(
    (event: TerminalLiveInputKeyPressEvent) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      const pendingText =
        pendingLiveInputHandleRef.current === activeHandle ? pendingLiveInputTextRef.current : ''
      if (pendingLiveInputHandleRef.current && pendingLiveInputHandleRef.current !== activeHandle) {
        clearPendingLiveInputCommit()
      }
      const decision = getTerminalLiveSpecialKeyDecision({
        key: event.nativeEvent.key,
        pendingText
      })
      switch (decision.kind) {
        case 'ignore':
        case 'local-edit':
          return
        case 'send-now':
          clearPendingLiveInputCommit()
          void sendTerminalLiveControlAfterPendingFlush(waitForPendingLiveInputFlush, () =>
            sendLiveTerminalInputRef.current(activeHandle, decision.bytes)
          )
          return
        case 'flush-then-send':
          void sendTerminalLiveControlAfterPendingFlush(
            () => flushPendingLiveInputText(activeHandle),
            () => sendLiveTerminalInputRef.current(activeHandle, decision.bytes)
          )
          return
        default:
          decision satisfies never
      }
    },
    [
      activeHandle,
      clearPendingLiveInputCommit,
      flushPendingLiveInputText,
      liveInputTerminalHandles,
      sendLiveTerminalInputRef,
      waitForPendingLiveInputFlush
    ]
  )

  const handleLiveInputAccessoryBytes = useTerminalLiveAccessoryInputCommit({
    activeHandle,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    liveInputRef,
    liveInputTerminalHandles,
    pendingLiveInputHandleRef,
    pendingLiveInputTextRef,
    schedulePendingLiveInputCommit,
    sendLiveTerminalInputRef,
    setLiveInputCapture,
    waitForPendingLiveInputFlush
  })

  const handleLiveInputSubmit = useCallback(() => {
    if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
      return
    }
    const pendingText =
      pendingLiveInputHandleRef.current === activeHandle ? pendingLiveInputTextRef.current : ''
    const sequence = getTerminalLiveSubmitSequence(pendingText)
    if (sequence.length === 2) {
      void sendTerminalLiveControlAfterPendingFlush(
        () => flushPendingLiveInputText(activeHandle),
        () => sendLiveTerminalInputRef.current(activeHandle, sequence[1])
      )
      return
    }
    clearPendingLiveInputCommit()
    void sendTerminalLiveControlAfterPendingFlush(waitForPendingLiveInputFlush, () =>
      sendLiveTerminalInputRef.current(activeHandle, sequence[0])
    )
  }, [
    activeHandle,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    liveInputTerminalHandles,
    sendLiveTerminalInputRef,
    waitForPendingLiveInputFlush
  ])

  return {
    clearPendingLiveInputCommit,
    flushPendingLiveInputBeforeExternalSend,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSubmit
  }
}
