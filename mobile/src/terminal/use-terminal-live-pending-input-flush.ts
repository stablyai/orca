import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { getTerminalInputByteLength } from '../../../src/shared/terminal-input'
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
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'

type TerminalLivePendingInputFlushOptions<TTabType extends string> = {
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly buildLivePasteText?: (handle: string, text: string) => string
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
  readonly sentLiveInputTextRef: RefObject<string>
  readonly waitForPendingLiveInputFlush: () => Promise<boolean>
}

export function useTerminalLivePendingInputFlush<TTabType extends string>({
  activeHandleRef,
  activeSessionTabTypeRef,
  buildLivePasteText,
  liveInputRef,
  liveInputTerminalHandlesRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLivePendingInputFlushOptions<TTabType>): TerminalLivePendingInputFlush {
  const mirrorRevisionRef = useRef(0)
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
    mirrorRevisionRef.current += 1
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

  const buildMirrorPayload = useCallback(
    (handle: string, step: TerminalLiveMirrorStep): string => {
      const appendText =
        buildLivePasteText && getTerminalInputByteLength(step.appendText) > 1024
          ? buildLivePasteText(handle, step.appendText)
          : step.appendText
      return buildTerminalLiveMirrorPayload({ ...step, appendText })
    },
    [buildLivePasteText]
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

      mirrorRevisionRef.current += 1
      const step = computeTerminalLiveMirrorStep(sentLiveInputTextRef.current, fieldText, {
        commitHeld,
        composing
      })
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

      const payload = buildMirrorPayload(handle, step)
      if (payload.length === 0) {
        return waitForPendingLiveInputFlush()
      }
      return queueTerminalLiveMirrorSend(
        pendingLiveInputFlushRef.current,
        handle,
        payload,
        sendQueuedMirrorPayload
      )
    },
    [
      activeHandleRef,
      activeSessionTabTypeRef,
      buildMirrorPayload,
      clearHeldCommitTimer,
      liveInputTerminalHandlesRef,
      resetMirrorState,
      sendQueuedMirrorPayload,
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

  const flushPendingLiveInputText = useCallback(
    async (expectedHandle: string | null): Promise<boolean> => {
      const handle = pendingLiveInputHandleRef.current
      if (handle && expectedHandle !== null && handle !== expectedHandle) {
        clearPendingLiveInputCommit()
      }

      const heldText = heldLiveInputTextRef.current
      const pending =
        handle && heldText.length > 0
          ? runMirrorStep(handle, sentLiveInputTextRef.current + heldText, true)
          : waitForPendingLiveInputFlush()
      const revision = mirrorRevisionRef.current
      const result = await pending
      // New edits or a reset supersede this flush and its follow-up external action.
      if (mirrorRevisionRef.current !== revision) {
        return false
      }

      // Why: an explicit flush ends the field's editing session; the echoed PTY
      // text stays, so local mirror state must restart from empty.
      clearPendingLiveInputCommit()
      return result
    },
    [clearPendingLiveInputCommit, runMirrorStep, waitForPendingLiveInputFlush]
  )

  // Queue preedit and click synchronously so the next keystroke follows the cursor move.
  const endLiveInputSessionThenSend = useCallback(
    (handle: string, bytes: string): Promise<boolean> => {
      mirrorRevisionRef.current += 1
      const pendingHandle = pendingLiveInputHandleRef.current
      const flushState = pendingLiveInputFlushRef.current
      if (pendingHandle && pendingHandle !== handle) {
        // Why: another terminal's queued deltas must not drain into this one.
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
      const sent = queueTerminalLiveMirrorSend(flushState, handle, bytes, sendQueuedMirrorPayload)
      clearHeldCommitTimer()
      heldLiveInputTextRef.current = ''
      liveInputComposingRef.current = undefined
      sentLiveInputTextRef.current = ''
      pendingLiveInputHandleRef.current = null
      setLiveInputCapture('')
      writeTerminalLiveInputText(liveInputRef, '')
      return sent
    },
    [
      buildMirrorPayload,
      clearHeldCommitTimer,
      liveInputRef,
      sendQueuedMirrorPayload,
      setLiveInputCapture
    ]
  )

  useEffect(() => {
    return () => {
      mirrorRevisionRef.current += 1
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
    sentLiveInputTextRef,
    waitForPendingLiveInputFlush
  }
}
