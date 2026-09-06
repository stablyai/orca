import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import type {
  TerminalLiveInputSender,
  TerminalLiveControlQueue
} from './terminal-live-input-sender'
import {
  buildTerminalLiveMirrorPayload,
  computeTerminalLiveMirrorStep,
  TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS
} from './terminal-live-preedit-mirror'
import {
  cancelTerminalLivePendingFlush,
  createTerminalLivePendingFlushState,
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'

type TerminalLivePendingInputFlushOptions<TTabType extends string> = {
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTerminalHandlesRef: RefObject<Set<string>>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

type RunTerminalLiveMirrorStep = (
  handle: string,
  fieldText: string,
  commitHeld: boolean,
  composing?: boolean
) => Promise<boolean>

type TerminalLivePendingInputFlush = {
  readonly applyLiveInputMirror: (
    handle: string,
    fieldText: string,
    composing?: boolean
  ) => Promise<boolean>
  readonly clearPendingLiveInputCommit: () => void
  readonly flushPendingLiveInputText: (expectedHandle: string | null) => Promise<boolean>
  readonly queueLiveInputControl: TerminalLiveControlQueue
  readonly heldLiveInputTextRef: RefObject<string>
  readonly liveInputComposingRef: RefObject<boolean | undefined>
  readonly pendingLiveInputHandleRef: RefObject<string | null>
  readonly sentLiveInputTextRef: RefObject<string>
  readonly waitForPendingLiveInputFlush: () => Promise<boolean>
}

export function useTerminalLivePendingInputFlush<TTabType extends string>({
  activeHandleRef,
  activeSessionTabTypeRef,
  liveInputRef,
  liveInputTerminalHandlesRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLivePendingInputFlushOptions<TTabType>): TerminalLivePendingInputFlush {
  const heldCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingLiveInputFlushRef = useRef(createTerminalLivePendingFlushState())
  const heldLiveInputTextRef = useRef('')
  const liveInputComposingRef = useRef<boolean | undefined>(undefined)
  const sentLiveInputTextRef = useRef('')
  const pendingLiveInputHandleRef = useRef<string | null>(null)
  const mirrorRevisionRef = useRef(0)
  const runMirrorStepRef = useRef<RunTerminalLiveMirrorStep>(async () => false)

  const clearHeldCommitTimer = useCallback(() => {
    if (heldCommitTimerRef.current) {
      clearTimeout(heldCommitTimerRef.current)
      heldCommitTimerRef.current = null
    }
  }, [])

  const clearMirrorState = useCallback(() => {
    mirrorRevisionRef.current += 1
    clearHeldCommitTimer()
    heldLiveInputTextRef.current = ''
    liveInputComposingRef.current = undefined
    sentLiveInputTextRef.current = ''
    pendingLiveInputHandleRef.current = null
  }, [clearHeldCommitTimer])

  const cancelPendingMirror = useCallback(() => {
    const state = pendingLiveInputFlushRef.current
    if (state.current && state.requestCount > 0) {
      const handles = new Set(
        [...state.activeBatches, ...state.pendingBatches].map((batch) => batch.handle)
      )
      for (const handle of handles) {
        sendLiveTerminalInputRef.current.cancelPending?.(handle)
      }
    }
    cancelTerminalLivePendingFlush(state)
  }, [sendLiveTerminalInputRef])

  const resetMirrorState = useCallback(() => {
    cancelPendingMirror()
    clearMirrorState()
  }, [cancelPendingMirror, clearMirrorState])

  const clearMirrorCapture = useCallback(() => {
    clearMirrorState()
    setLiveInputCapture('')
    liveInputRef.current?.setNativeProps({ text: '' })
  }, [clearMirrorState, liveInputRef, setLiveInputCapture])

  const clearPendingLiveInputCommit = useCallback(() => {
    cancelPendingMirror()
    clearMirrorCapture()
  }, [cancelPendingMirror, clearMirrorCapture])

  const clearRejectedMirror = useCallback(
    (handle: string) => {
      clearMirrorCapture()
      // Keep the failed lane owned so terminal switches can cancel it.
      pendingLiveInputHandleRef.current = handle
    },
    [clearMirrorCapture]
  )

  const waitForPendingLiveInputFlush = useCallback(async (): Promise<boolean> => {
    return waitForTerminalLivePendingFlush(pendingLiveInputFlushRef.current)
  }, [])

  const sendQueuedMirrorPayload = useCallback(
    (handle: string, payload: string): Promise<boolean> => {
      if (
        handle !== activeHandleRef.current ||
        (activeSessionTabTypeRef.current != null && activeSessionTabTypeRef.current !== 'terminal')
      ) {
        return Promise.resolve(false)
      }
      return sendLiveTerminalInputRef.current(handle, payload)
    },
    [sendLiveTerminalInputRef, activeHandleRef, activeSessionTabTypeRef]
  )

  const runMirrorStep = useCallback<RunTerminalLiveMirrorStep>(
    async (handle, fieldText, commitHeld, composing) => {
      if (
        handle !== activeHandleRef.current ||
        (activeSessionTabTypeRef.current != null &&
          activeSessionTabTypeRef.current !== 'terminal') ||
        !liveInputTerminalHandlesRef.current.has(handle)
      ) {
        // Why: a stale handle must not keep local mirror state alive — the next
        // active terminal would inherit wrong erase counts. A null tab type is
        // "unknown" during tab-list lag, not "left the terminal", so it must not trip.
        resetMirrorState()
        return false
      }

      const step = computeTerminalLiveMirrorStep(sentLiveInputTextRef.current, fieldText, {
        commitHeld,
        composing
      })
      const revision = ++mirrorRevisionRef.current
      const generation = pendingLiveInputFlushRef.current.generation
      sentLiveInputTextRef.current = step.nextSentText
      heldLiveInputTextRef.current = step.heldText
      liveInputComposingRef.current = composing
      pendingLiveInputHandleRef.current =
        step.heldText.length > 0 || step.nextSentText.length > 0 ? handle : null

      clearHeldCommitTimer()
      // Why: text the platform positively marked as preedit is not text yet, so
      // no idle timer may commit it. Only an unreported hold is a guess that has
      // to settle on its own.
      if (step.heldText.length > 0 && composing === undefined) {
        heldCommitTimerRef.current = setTimeout(() => {
          heldCommitTimerRef.current = null
          const heldField = sentLiveInputTextRef.current + heldLiveInputTextRef.current
          void runMirrorStepRef.current(handle, heldField, true)
        }, TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)
      }

      const payload = buildTerminalLiveMirrorPayload(step)
      const reportFailure = sendLiveTerminalInputRef.current.captureFailureReporter?.(handle)
      const sent = await (payload.length === 0
        ? waitForPendingLiveInputFlush()
        : queueTerminalLiveMirrorSend(
            pendingLiveInputFlushRef.current,
            handle,
            payload,
            sendQueuedMirrorPayload,
            { pipeline: sendLiveTerminalInputRef.current.supportsPipeline?.(handle) === true }
          ))
      if (
        !sent &&
        generation === pendingLiveInputFlushRef.current.generation &&
        pendingLiveInputFlushRef.current.failed
      ) {
        reportFailure?.()
      }
      if (
        !sent &&
        generation === pendingLiveInputFlushRef.current.generation &&
        revision === mirrorRevisionRef.current &&
        activeHandleRef.current === handle &&
        (activeSessionTabTypeRef.current == null ||
          activeSessionTabTypeRef.current === 'terminal') &&
        liveInputTerminalHandlesRef.current.has(handle)
      ) {
        clearRejectedMirror(handle)
      }
      return sent
    },
    [
      activeHandleRef,
      activeSessionTabTypeRef,
      clearHeldCommitTimer,
      clearRejectedMirror,
      liveInputTerminalHandlesRef,
      resetMirrorState,
      sendQueuedMirrorPayload,
      sendLiveTerminalInputRef,
      waitForPendingLiveInputFlush
    ]
  )
  // Why: assigning during render is not replay-safe. The only read is inside a
  // held-commit timer, which fires long after commit, so an effect is soon enough.
  useEffect(() => {
    runMirrorStepRef.current = runMirrorStep
  }, [runMirrorStep])

  const applyLiveInputMirror = useCallback(
    (handle: string, fieldText: string, composing?: boolean): Promise<boolean> =>
      runMirrorStep(handle, fieldText, false, composing),
    [runMirrorStep]
  )

  const queueLiveInputControl = useCallback<TerminalLiveControlQueue>(
    (handle, bytes, send): Promise<boolean> => {
      if (
        handle !== activeHandleRef.current ||
        (!send && !liveInputTerminalHandlesRef.current.has(handle))
      ) {
        return Promise.resolve(false)
      }
      const pendingHandle = pendingLiveInputHandleRef.current
      if (pendingHandle && pendingHandle !== handle) {
        clearPendingLiveInputCommit()
        return Promise.resolve(false)
      }
      if (heldLiveInputTextRef.current.length > 0) {
        void runMirrorStep(
          handle,
          sentLiveInputTextRef.current + heldLiveInputTextRef.current,
          true
        )
      }
      // End this field now; a receipt must never clear text from a later native event.
      clearMirrorCapture()
      pendingLiveInputHandleRef.current = handle
      const generation = pendingLiveInputFlushRef.current.generation
      const reportFailure = sendLiveTerminalInputRef.current.captureFailureReporter?.(handle)
      const isCurrent = () =>
        generation === pendingLiveInputFlushRef.current.generation &&
        handle === activeHandleRef.current &&
        (activeSessionTabTypeRef.current == null || activeSessionTabTypeRef.current === 'terminal')
      return queueTerminalLiveMirrorSend(
        pendingLiveInputFlushRef.current,
        handle,
        bytes,
        send
          ? () => (isCurrent() ? send(isCurrent) : Promise.resolve(false))
          : sendQueuedMirrorPayload,
        { barrier: true }
      ).then((sent) => {
        if (!sent && isCurrent() && pendingLiveInputFlushRef.current.failed) {
          reportFailure?.()
        }
        return sent
      })
    },
    [
      activeHandleRef,
      liveInputTerminalHandlesRef,
      clearPendingLiveInputCommit,
      runMirrorStep,
      clearMirrorCapture,
      sendQueuedMirrorPayload,
      activeSessionTabTypeRef,
      sendLiveTerminalInputRef
    ]
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
      const flush =
        heldText.length > 0
          ? runMirrorStep(handle, sentLiveInputTextRef.current + heldText, true)
          : waitForPendingLiveInputFlush()
      clearMirrorCapture()
      pendingLiveInputHandleRef.current = handle
      return flush
    },
    [clearPendingLiveInputCommit, clearMirrorCapture, runMirrorStep, waitForPendingLiveInputFlush]
  )

  useEffect(() => {
    return resetMirrorState
  }, [resetMirrorState])

  return {
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    queueLiveInputControl,
    heldLiveInputTextRef,
    liveInputComposingRef,
    pendingLiveInputHandleRef,
    sentLiveInputTextRef,
    waitForPendingLiveInputFlush
  }
}
