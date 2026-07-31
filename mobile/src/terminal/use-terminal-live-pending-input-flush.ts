import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS } from './terminal-live-hangul-mirror'
import {
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'
import {
  planTerminalLiveFieldTextChange,
  planTerminalLiveSelectionMove,
  type TerminalLiveNativeSelection,
  type TerminalLiveSelectionCursorState
} from './terminal-live-selection-cursor'
import {
  buildTerminalLiveFieldCommitPrefix,
  buildTerminalLiveQueuedControlPayload,
  type TerminalLiveQueueControlOptions
} from './terminal-live-control-payload'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'

type TerminalLivePendingInputFlushOptions<TTabType extends string> = {
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTerminalHandlesRef: RefObject<Set<string>>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

export function useTerminalLivePendingInputFlush<TTabType extends string>({
  activeHandleRef,
  activeSessionTabTypeRef,
  liveInputRef,
  liveInputTerminalHandlesRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLivePendingInputFlushOptions<TTabType>) {
  const heldCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingLiveInputFlushRef = useRef<Promise<boolean> | null>(null)
  const heldLiveInputTextRef = useRef('')
  const sentLiveInputTextRef = useRef('')
  const pendingLiveInputHandleRef = useRef<string | null>(null)
  const ptyCursorCodePointRef = useRef(0)
  const mirroredFieldTextRef = useRef('')
  const runMirrorStepRef = useRef<
    (handle: string, rawFieldText: string, commitHeld: boolean) => Promise<boolean>
  >(async () => false)

  const clearHeldCommitTimer = useCallback(() => {
    if (heldCommitTimerRef.current) {
      clearTimeout(heldCommitTimerRef.current)
      heldCommitTimerRef.current = null
    }
  }, [])

  const resetMirrorState = useCallback(() => {
    clearHeldCommitTimer()
    heldLiveInputTextRef.current = ''
    sentLiveInputTextRef.current = ''
    pendingLiveInputHandleRef.current = null
    ptyCursorCodePointRef.current = 0
    mirroredFieldTextRef.current = ''
  }, [clearHeldCommitTimer])

  const clearPendingLiveInputCommit = useCallback(() => {
    resetMirrorState()
    setLiveInputCapture('')
    liveInputRef.current?.setNativeProps({ text: '' })
  }, [liveInputRef, resetMirrorState, setLiveInputCapture])

  const waitForPendingLiveInputFlush = useCallback(async (): Promise<boolean> => {
    return waitForTerminalLivePendingFlush(pendingLiveInputFlushRef)
  }, [])

  const isHandleLive = useCallback(
    (handle: string): boolean =>
      handle === activeHandleRef.current &&
      (activeSessionTabTypeRef.current == null || activeSessionTabTypeRef.current === 'terminal') &&
      liveInputTerminalHandlesRef.current.has(handle),
    [activeHandleRef, activeSessionTabTypeRef, liveInputTerminalHandlesRef]
  )

  const readCursorState = useCallback(
    (): TerminalLiveSelectionCursorState => ({
      sentText: sentLiveInputTextRef.current,
      heldText: heldLiveInputTextRef.current,
      ptyCursorCodePoint: ptyCursorCodePointRef.current,
      fieldText: mirroredFieldTextRef.current
    }),
    []
  )

  const applyPlanState = useCallback(
    (
      handle: string,
      plan: {
        readonly nextSentText: string
        readonly heldText: string
        readonly nextPtyCursorCodePoint: number
        readonly nextFieldText: string
      }
    ): void => {
      sentLiveInputTextRef.current = plan.nextSentText
      heldLiveInputTextRef.current = plan.heldText
      ptyCursorCodePointRef.current = plan.nextPtyCursorCodePoint
      mirroredFieldTextRef.current = plan.nextFieldText
      pendingLiveInputHandleRef.current =
        plan.heldText.length > 0 || plan.nextSentText.length > 0 ? handle : null
    },
    []
  )

  const queuePayload = useCallback(
    (handle: string, payload: string): Promise<boolean> => {
      if (payload.length === 0) {
        return waitForPendingLiveInputFlush()
      }
      return queueTerminalLiveMirrorSend(pendingLiveInputFlushRef, () =>
        sendLiveTerminalInputRef.current(handle, payload)
      )
    },
    [sendLiveTerminalInputRef, waitForPendingLiveInputFlush]
  )

  const scheduleHeldCommit = useCallback(
    (handle: string): void => {
      clearHeldCommitTimer()
      if (heldLiveInputTextRef.current.length === 0) {
        return
      }
      heldCommitTimerRef.current = setTimeout(() => {
        heldCommitTimerRef.current = null
        const heldField = sentLiveInputTextRef.current + heldLiveInputTextRef.current
        void runMirrorStepRef.current(handle, heldField, true)
      }, TERMINAL_LIVE_HELD_SYLLABLE_COMMIT_DELAY_MS)
    },
    [clearHeldCommitTimer]
  )

  const runMirrorStep = useCallback(
    async (handle: string, rawFieldText: string, commitHeld: boolean): Promise<boolean> => {
      if (!isHandleLive(handle)) {
        // Why: stale handle must not keep erase counts; null tab type is unknown lag.
        resetMirrorState()
        return false
      }
      const plan = planTerminalLiveFieldTextChange(readCursorState(), rawFieldText, null, {
        normalize: normalizeTerminalTextInput,
        commitHeld
      })
      applyPlanState(handle, plan)
      scheduleHeldCommit(handle)
      return queuePayload(handle, plan.payload)
    },
    [
      applyPlanState,
      isHandleLive,
      queuePayload,
      readCursorState,
      resetMirrorState,
      scheduleHeldCommit
    ]
  )
  runMirrorStepRef.current = runMirrorStep

  const applyLiveInputMirror = useCallback(
    (
      handle: string,
      rawFieldText: string,
      selection?: TerminalLiveNativeSelection | null
    ): void => {
      if (!isHandleLive(handle)) {
        resetMirrorState()
        return
      }
      const plan = planTerminalLiveFieldTextChange(
        readCursorState(),
        rawFieldText,
        selection ?? null,
        {
          normalize: normalizeTerminalTextInput,
          commitHeld: false
        }
      )
      applyPlanState(handle, plan)
      scheduleHeldCommit(handle)
      void queuePayload(handle, plan.payload)
    },
    [
      applyPlanState,
      isHandleLive,
      queuePayload,
      readCursorState,
      resetMirrorState,
      scheduleHeldCommit
    ]
  )

  const applyLiveInputSelection = useCallback(
    (handle: string, rawFieldText: string, selection: TerminalLiveNativeSelection): void => {
      if (!isHandleLive(handle)) {
        resetMirrorState()
        return
      }
      const plan = planTerminalLiveSelectionMove(readCursorState(), selection, {
        normalize: normalizeTerminalTextInput,
        rawFieldText
      })
      if (!plan) {
        return
      }
      applyPlanState(handle, plan)
      scheduleHeldCommit(handle)
      void queuePayload(handle, plan.payload)
    },
    [
      applyPlanState,
      isHandleLive,
      queuePayload,
      readCursorState,
      resetMirrorState,
      scheduleHeldCommit
    ]
  )

  // Why: control bytes share the mirror send chain; commit-before-control snapshots
  // restore/held into the same payload without applying plan state (caller clears).
  const queueLiveInputControl = useCallback(
    (handle: string, bytes: string, options: TerminalLiveQueueControlOptions): Promise<boolean> => {
      if (!isHandleLive(handle)) {
        resetMirrorState()
        return Promise.resolve(false)
      }
      const ownsFieldState =
        pendingLiveInputHandleRef.current === handle &&
        (sentLiveInputTextRef.current.length > 0 || heldLiveInputTextRef.current.length > 0)
      const payload = buildTerminalLiveQueuedControlPayload({
        state: readCursorState(),
        ownsFieldState,
        commitFieldBeforeControl: options.commitFieldBeforeControl,
        controlBytes: bytes
      })
      return queuePayload(handle, payload)
    },
    [isHandleLive, queuePayload, readCursorState, resetMirrorState]
  )

  const flushPendingLiveInputText = useCallback(
    async (expectedHandle: string | null): Promise<boolean> => {
      const handle = pendingLiveInputHandleRef.current
      if (!handle) {
        return waitForPendingLiveInputFlush()
      }
      if (expectedHandle !== null && handle !== expectedHandle) {
        clearPendingLiveInputCommit()
        return waitForPendingLiveInputFlush()
      }
      const heldText = heldLiveInputTextRef.current
      const sentText = sentLiveInputTextRef.current
      const needsEndRestore =
        heldText.length > 0 || ptyCursorCodePointRef.current < Array.from(sentText).length
      // Snapshot then clear old session sync before await so new IME is not wiped.
      const sendPromise = needsEndRestore
        ? queuePayload(handle, buildTerminalLiveFieldCommitPrefix(readCursorState()))
        : waitForPendingLiveInputFlush()
      clearPendingLiveInputCommit()
      return sendPromise
    },
    [clearPendingLiveInputCommit, queuePayload, readCursorState, waitForPendingLiveInputFlush]
  )

  useEffect(() => {
    return () => {
      resetMirrorState()
      pendingLiveInputFlushRef.current = null
    }
  }, [resetMirrorState])

  return {
    applyLiveInputMirror,
    applyLiveInputSelection,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    heldLiveInputTextRef,
    pendingLiveInputHandleRef,
    queueLiveInputControl,
    sentLiveInputTextRef,
    waitForPendingLiveInputFlush
  }
}
