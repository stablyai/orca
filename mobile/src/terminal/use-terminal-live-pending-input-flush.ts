import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { getTerminalInputByteLength } from '../../../src/shared/terminal-input'
import {
  UNFRAMED_AGENT_INPUT_MAX_BYTES,
  wrapTerminalBracketedPasteText
} from '../../../src/shared/terminal-bracketed-paste-text'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { writeTerminalLiveInputText } from './terminal-live-input-text-write'
import {
  buildTerminalLiveMirrorPayload,
  computeTerminalLiveMirrorStep,
  TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS,
  type TerminalLiveMirrorStep
} from './terminal-live-preedit-mirror'
import {
  cancelTerminalLivePendingFlush,
  createTerminalLivePendingFlushState,
  queueTerminalLiveControlSend,
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'

type TerminalLivePendingInputFlushOptions<TTabType extends string> = {
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly framesLivePaste?: (handle: string) => boolean
  readonly onPasteEndsFieldSession?: (handle: string) => void
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
  readonly endLiveInputSessionThenSend: (handle: string, bytes: string) => Promise<boolean>
  readonly flushPendingLiveInputText: (expectedHandle: string | null) => Promise<boolean>
  readonly heldLiveInputTextRef: RefObject<string>
  readonly liveInputComposingRef: RefObject<boolean | undefined>
  readonly pendingLiveInputHandleRef: RefObject<string | null>
  readonly queueLiveInputControl: (handle: string, bytes: string) => Promise<boolean>
  readonly sentLiveInputTextRef: RefObject<string>
  readonly waitForPendingLiveInputFlush: () => Promise<boolean>
}

export function useTerminalLivePendingInputFlush<TTabType extends string>({
  activeHandleRef,
  activeSessionTabTypeRef,
  framesLivePaste,
  onPasteEndsFieldSession,
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
  const runMirrorStepRef = useRef<RunTerminalLiveMirrorStep>(async () => false)

  const clearHeldCommitTimer = useCallback(() => {
    if (heldCommitTimerRef.current) {
      clearTimeout(heldCommitTimerRef.current)
      heldCommitTimerRef.current = null
    }
  }, [])

  const resetMirrorState = useCallback(() => {
    clearHeldCommitTimer()
    cancelTerminalLivePendingFlush(pendingLiveInputFlushRef.current)
    heldLiveInputTextRef.current = ''
    liveInputComposingRef.current = undefined
    sentLiveInputTextRef.current = ''
    pendingLiveInputHandleRef.current = null
  }, [clearHeldCommitTimer])

  const clearPendingLiveInputCommit = useCallback(() => {
    resetMirrorState()
    setLiveInputCapture('')
    writeTerminalLiveInputText(liveInputRef, '')
  }, [liveInputRef, resetMirrorState, setLiveInputCapture])

  const waitForPendingLiveInputFlush = useCallback(async (): Promise<boolean> => {
    return waitForTerminalLivePendingFlush(pendingLiveInputFlushRef.current)
  }, [])

  const sendQueuedMirrorPayload = useCallback(
    (handle: string, payload: string): Promise<boolean> =>
      sendLiveTerminalInputRef.current(handle, payload),
    [sendLiveTerminalInputRef]
  )

  // A single append this long is an OS paste, or an edit before one; frame it like a paste.
  const isFramedPasteAppend = useCallback(
    (handle: string, step: TerminalLiveMirrorStep): boolean =>
      getTerminalInputByteLength(step.appendText) > UNFRAMED_AGENT_INPUT_MAX_BYTES &&
      framesLivePaste?.(handle) === true,
    [framesLivePaste]
  )
  const buildMirrorPayload = useCallback(
    (handle: string, step: TerminalLiveMirrorStep): string =>
      buildTerminalLiveMirrorPayload(
        isFramedPasteAppend(handle, step)
          ? { ...step, appendText: wrapTerminalBracketedPasteText(step.appendText) }
          : step
      ),
    [isFramedPasteAppend]
  )

  const runMirrorStep = useCallback<RunTerminalLiveMirrorStep>(
    async (handle, fieldText, commitHeld, composing) => {
      if (
        handle !== activeHandleRef.current ||
        (activeSessionTabTypeRef.current != null &&
          activeSessionTabTypeRef.current !== 'terminal') ||
        !liveInputTerminalHandlesRef.current.has(handle)
      ) {
        // Stale handles must drop mirror erase counts, but null tab type during list lag does not prove departure.
        resetMirrorState()
        return false
      }

      const typedStep = computeTerminalLiveMirrorStep(sentLiveInputTextRef.current, fieldText, {
        commitHeld,
        composing
      })
      // Agents may collapse a framed paste into one token, so commit the whole field and end its session.
      const pasted = isFramedPasteAppend(handle, typedStep)
      const step =
        pasted && typedStep.heldText.length > 0
          ? computeTerminalLiveMirrorStep(sentLiveInputTextRef.current, fieldText, {
              commitHeld: true
            })
          : typedStep
      sentLiveInputTextRef.current = step.nextSentText
      heldLiveInputTextRef.current = step.heldText
      liveInputComposingRef.current = composing
      pendingLiveInputHandleRef.current =
        step.heldText.length > 0 ||
        step.nextSentText.length > 0 ||
        pendingLiveInputFlushRef.current.current
          ? handle
          : null

      clearHeldCommitTimer()
      // Reported preedit must never idle-commit; only unreported heuristic holds may settle on a timer.
      if (step.heldText.length > 0 && composing === undefined) {
        heldCommitTimerRef.current = setTimeout(() => {
          heldCommitTimerRef.current = null
          const heldField = sentLiveInputTextRef.current + heldLiveInputTextRef.current
          void runMirrorStepRef.current(handle, heldField, true)
        }, TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)
      }

      const payload = buildMirrorPayload(handle, step)
      if (payload.length === 0) {
        return waitForPendingLiveInputFlush()
      }
      const sent = queueTerminalLiveMirrorSend(
        pendingLiveInputFlushRef.current,
        handle,
        payload,
        sendQueuedMirrorPayload
      )
      if (pasted) {
        onPasteEndsFieldSession?.(handle)
        clearHeldCommitTimer()
        heldLiveInputTextRef.current = ''
        liveInputComposingRef.current = undefined
        sentLiveInputTextRef.current = ''
        setLiveInputCapture('')
        writeTerminalLiveInputText(liveInputRef, '')
      }
      return sent
    },
    [
      activeHandleRef,
      activeSessionTabTypeRef,
      buildMirrorPayload,
      clearHeldCommitTimer,
      isFramedPasteAppend,
      liveInputRef,
      onPasteEndsFieldSession,
      liveInputTerminalHandlesRef,
      resetMirrorState,
      sendQueuedMirrorPayload,
      setLiveInputCapture,
      waitForPendingLiveInputFlush
    ]
  )
  // Commit the timer’s input ref in an effect; render writes would leak discarded work.
  useEffect(() => {
    runMirrorStepRef.current = runMirrorStep
  }, [runMirrorStep])

  const applyLiveInputMirror = useCallback(
    (handle: string, fieldText: string, composing?: boolean): Promise<boolean> =>
      runMirrorStep(handle, fieldText, false, composing),
    [runMirrorStep]
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
      const result =
        heldText.length > 0
          ? await runMirrorStep(handle, sentLiveInputTextRef.current + heldText, true)
          : await waitForPendingLiveInputFlush()

      // Flush ends the field session while retaining PTY echo, so local mirror state restarts empty.
      clearPendingLiveInputCommit()
      return result
    },
    [clearPendingLiveInputCommit, runMirrorStep, waitForPendingLiveInputFlush]
  )

  // Queue at key time; waiting for the drain would let text typed meanwhile go first.
  const queueLiveInputControl = useCallback(
    (handle: string, bytes: string): Promise<boolean> => {
      // Own the queued bytes so a terminal switch retires them even with an empty field.
      pendingLiveInputHandleRef.current = handle
      return queueTerminalLiveControlSend(
        pendingLiveInputFlushRef.current,
        handle,
        bytes,
        sendQueuedMirrorPayload
      )
    },
    [sendQueuedMirrorPayload]
  )

  // Queue held text and the control synchronously so the next keystroke follows them.
  const endLiveInputSessionThenSend = useCallback(
    (handle: string, bytes: string): Promise<boolean> => {
      const pendingHandle = pendingLiveInputHandleRef.current
      const flushState = pendingLiveInputFlushRef.current
      if (pendingHandle && pendingHandle !== handle) {
        // Never drain another terminal’s queued deltas into the current one.
        cancelTerminalLivePendingFlush(flushState)
      } else if (pendingHandle === handle && heldLiveInputTextRef.current.length > 0) {
        const sentText = sentLiveInputTextRef.current
        const payload = buildMirrorPayload(
          handle,
          computeTerminalLiveMirrorStep(sentText, sentText + heldLiveInputTextRef.current, {
            commitHeld: true
          })
        )
        if (payload.length > 0) {
          void queueTerminalLiveMirrorSend(flushState, handle, payload, sendQueuedMirrorPayload)
        }
      }
      const sent = queueLiveInputControl(handle, bytes)
      clearHeldCommitTimer()
      heldLiveInputTextRef.current = ''
      liveInputComposingRef.current = undefined
      sentLiveInputTextRef.current = ''
      setLiveInputCapture('')
      writeTerminalLiveInputText(liveInputRef, '')
      return sent
    },
    [
      buildMirrorPayload,
      clearHeldCommitTimer,
      liveInputRef,
      queueLiveInputControl,
      sendQueuedMirrorPayload,
      setLiveInputCapture
    ]
  )

  useEffect(() => {
    return () => {
      if (heldCommitTimerRef.current) {
        clearTimeout(heldCommitTimerRef.current)
        heldCommitTimerRef.current = null
      }
      heldLiveInputTextRef.current = ''
      liveInputComposingRef.current = undefined
      sentLiveInputTextRef.current = ''
      pendingLiveInputHandleRef.current = null
      cancelTerminalLivePendingFlush(pendingLiveInputFlushRef.current)
    }
  }, [])

  return {
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
  }
}
