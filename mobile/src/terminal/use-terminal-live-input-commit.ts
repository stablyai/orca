import { useCallback, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { reportedLiveInputComposing } from '../platform/live-input-composing-range'
import { getTerminalLiveSpecialKeyDecision } from './terminal-live-text-commit'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'
import { useTerminalLivePendingInputFlush } from './use-terminal-live-pending-input-flush'
import type { TerminalLiveInputFailure } from './terminal-live-pending-flush-state'
import { useTerminalLiveSessionRetention } from './use-terminal-live-session-retention'
import {
  readLiveInputSelection,
  useTerminalLiveAccessoryInputCommit,
  type TerminalLiveAccessoryInputCommitResult
} from './use-terminal-live-accessory-input-commit'

type TerminalLiveInputKeyPressEvent = {
  readonly nativeEvent: {
    readonly key: string
  }
}

// Preserve the patched iOS marked-text payload; absence means unreported composition, not not-composing.
type TerminalLiveInputChangeEvent = {
  readonly nativeEvent: {
    readonly text: string
    readonly isComposing?: boolean
    readonly inputType?: string
  }
}

type TerminalLiveInputCommitOptions<TTabType extends string> = {
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabType: TTabType | null | undefined
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly framesLivePaste?: (handle: string) => boolean
  readonly onSendFailure?: (failure: TerminalLiveInputFailure) => void
  readonly connected: boolean
  readonly liveInputRef: RefObject<TextInput | null>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

type TerminalLiveInputCommitHandlers = {
  readonly clearPendingLiveInputCommit: () => void
  readonly clearSavedLiveInputSession: (handle?: string) => void
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly getLiveInputInteractionGeneration: () => number
  readonly handleLiveInputAccessoryBytes: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly handleLiveInputChange: (event: TerminalLiveInputChangeEvent) => void
  readonly handleLiveInputCompositionEnd: (text: string) => void
  readonly handleLiveInputKeyPress: (event: TerminalLiveInputKeyPressEvent) => void
  readonly handleLiveInputSubmit: () => Promise<boolean>
  readonly seedLiveInputFromTerminalPrompt: (handle: string, promptText: string) => boolean
  readonly sendLiveInputClick: (handle: string, bytes: string) => Promise<boolean>
}

export function useTerminalLiveInputCommit<TTabType extends string>({
  activeHandle,
  activeHandleRef,
  activeSessionTabType,
  activeSessionTabTypeRef,
  framesLivePaste,
  onSendFailure,
  connected,
  liveInputRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLiveInputCommitOptions<TTabType>): TerminalLiveInputCommitHandlers {
  const liveInputInteractionGenerationRef = useRef(0)
  // Click guards compare against the field text cleared before the cursor moved.
  const liveInputTextRef = useRef('')
  const onFieldSessionEndedRef = useRef<(handle: string) => void>(() => {})
  const updateLiveInputCapture = useCallback(
    (text: string) => {
      liveInputTextRef.current = text
      setLiveInputCapture(text)
    },
    [setLiveInputCapture]
  )
  const advanceLiveInputInteractionGeneration = useCallback(() => {
    liveInputInteractionGenerationRef.current += 1
  }, [])

  const {
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    endLiveInputSessionThenSend,
    flushPendingLiveInputText,
    heldLiveInputTextRef,
    liveInputComposingRef,
    pendingLiveInputHandleRef,
    queueLiveInputControl,
    sentLiveInputTextRef,
    waitForPendingLiveInputFlush
  } = useTerminalLivePendingInputFlush({
    activeHandleRef,
    activeSessionTabTypeRef,
    framesLivePaste,
    liveInputRef,
    onFieldSessionEnded: (handle) => onFieldSessionEndedRef.current(handle),
    onSendFailure,
    sendLiveTerminalInputRef,
    setLiveInputCapture: updateLiveInputCapture
  })

  const {
    clearEndedSessionEcho,
    clearSavedLiveInputSession,
    dropEndedSessionEcho,
    recordEndedSession,
    seedLiveInputFromTerminalPrompt
  } = useTerminalLiveSessionRetention({
    activeHandle,
    activeHandleRef,
    activeSessionTabType,
    activeSessionTabTypeRef,
    clearPendingLiveInputCommit,
    connected,
    heldLiveInputTextRef,
    liveInputRef,
    liveInputTextRef,
    pendingLiveInputHandleRef,
    sentLiveInputTextRef,
    updateLiveInputCapture
  })
  onFieldSessionEndedRef.current = (handle) => {
    clearSavedLiveInputSession(handle)
    recordEndedSession(handle)
  }

  const flushPendingLiveInputBeforeExternalSend = useCallback(
    async (handle: string): Promise<boolean> => {
      advanceLiveInputInteractionGeneration()
      clearSavedLiveInputSession(handle)
      const pendingHandle = pendingLiveInputHandleRef.current
      if (pendingHandle && pendingHandle !== handle) {
        clearPendingLiveInputCommit()
        return waitForPendingLiveInputFlush()
      }
      // External bytes follow field echo; end the field session so later diffs cannot erase dictation/paste.
      if (pendingHandle === handle) {
        return flushPendingLiveInputText(handle)
      }
      return waitForPendingLiveInputFlush()
    },
    [
      advanceLiveInputInteractionGeneration,
      clearPendingLiveInputCommit,
      clearSavedLiveInputSession,
      flushPendingLiveInputText,
      waitForPendingLiveInputFlush
    ]
  )

  // Clicks, Return and held-text controls leave the mirror’s assumed field; start a new editing session.
  const endFieldSessionThenSend = useCallback<TerminalLiveInputSender>(
    (handle, bytes, origin) => {
      advanceLiveInputInteractionGeneration()
      clearSavedLiveInputSession(handle)
      recordEndedSession(handle)
      return endLiveInputSessionThenSend(handle, bytes, origin)
    },
    [
      advanceLiveInputInteractionGeneration,
      clearSavedLiveInputSession,
      endLiveInputSessionThenSend,
      recordEndedSession
    ]
  )

  const sendLiveInputClick = useCallback(
    (handle: string, bytes: string) => endFieldSessionThenSend(handle, bytes, 'pointer'),
    [endFieldSessionThenSend]
  )

  const handleLiveInputChange = useCallback(
    ({ nativeEvent }: TerminalLiveInputChangeEvent) => {
      if (!activeHandle) {
        clearPendingLiveInputCommit()
        return
      }
      // Echo native field text verbatim so iOS keeps dictation/IME alive; normalize only the PTY mirror.
      advanceLiveInputInteractionGeneration()
      // DOM input signals fresh edits even when mobile keyboards omit key events.
      if (nativeEvent.inputType) {
        clearEndedSessionEcho()
      } else if (dropEndedSessionEcho(nativeEvent.text)) {
        return
      }
      updateLiveInputCapture(nativeEvent.text)
      void applyLiveInputMirror(
        activeHandle,
        normalizeTerminalTextInput(nativeEvent.text),
        reportedLiveInputComposing(nativeEvent.isComposing)
      )
    },
    [
      activeHandle,
      advanceLiveInputInteractionGeneration,
      applyLiveInputMirror,
      clearEndedSessionEcho,
      clearPendingLiveInputCommit,
      dropEndedSessionEcho,
      updateLiveInputCapture
    ]
  )

  // A commit with no trailing input event would otherwise stay held until the next key.
  const handleLiveInputCompositionEnd = useCallback(
    (text: string) => handleLiveInputChange({ nativeEvent: { text, isComposing: false } }),
    [handleLiveInputChange]
  )

  const getLiveInputInteractionGeneration = useCallback(
    () => liveInputInteractionGenerationRef.current,
    []
  )

  const handleLiveInputKeyPress = useCallback(
    (event: TerminalLiveInputKeyPressEvent) => {
      if (!activeHandle) {
        return
      }
      advanceLiveInputInteractionGeneration()
      clearEndedSessionEcho()
      const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
      if (pendingLiveInputHandleRef.current && !ownsPendingState) {
        clearPendingLiveInputCommit()
      }
      const fieldText = liveInputTextRef.current
      // Key events precede the caret move, so this is where the key starts from.
      const selection = readLiveInputSelection(liveInputRef.current, fieldText)
      const decision = getTerminalLiveSpecialKeyDecision({
        key: event.nativeEvent.key,
        heldText: ownsPendingState ? heldLiveInputTextRef.current : '',
        sentText: ownsPendingState ? sentLiveInputTextRef.current : '',
        caretAtFieldEnd:
          !selection || (selection.start === fieldText.length && selection.end === fieldText.length)
      })
      switch (decision.kind) {
        case 'ignore':
        case 'local-edit':
          return
        case 'send-now':
          clearSavedLiveInputSession(activeHandle)
          void queueLiveInputControl(activeHandle, decision.bytes)
          return
        case 'commit-held-then-send':
          void endFieldSessionThenSend(activeHandle, decision.bytes)
          return
        default:
          decision satisfies never
      }
    },
    [
      activeHandle,
      advanceLiveInputInteractionGeneration,
      clearEndedSessionEcho,
      clearPendingLiveInputCommit,
      clearSavedLiveInputSession,
      endFieldSessionThenSend,
      liveInputRef,
      queueLiveInputControl
    ]
  )

  const handleLiveInputAccessoryBytes = useTerminalLiveAccessoryInputCommit({
    activeHandle,
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    endLiveInputSessionThenSend: endFieldSessionThenSend,
    heldLiveInputTextRef,
    liveInputComposingRef,
    liveInputRef,
    liveInputTextRef,
    onInteraction: advanceLiveInputInteractionGeneration,
    pendingLiveInputHandleRef,
    queueLiveInputControl,
    sentLiveInputTextRef,
    setLiveInputCapture: updateLiveInputCapture
  })

  const handleLiveInputSubmit = useCallback((): Promise<boolean> => {
    if (!activeHandle) {
      return Promise.resolve(false)
    }
    return endFieldSessionThenSend(activeHandle, '\r')
  }, [activeHandle, endFieldSessionThenSend])

  return {
    clearPendingLiveInputCommit,
    clearSavedLiveInputSession,
    flushPendingLiveInputBeforeExternalSend,
    getLiveInputInteractionGeneration,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputCompositionEnd,
    handleLiveInputKeyPress,
    handleLiveInputSubmit,
    seedLiveInputFromTerminalPrompt,
    sendLiveInputClick
  }
}
