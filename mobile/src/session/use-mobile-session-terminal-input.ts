import { reportWorkerTerminalUserInput } from '../terminal/worker-terminal-takeover-report'
import { useCallback } from 'react'
import { terminalBufferClear, terminalInputSend } from '../terminal/mobile-terminal-operations'
import {
  clearTerminalLiveInputFocusTimer,
  scheduleTerminalLiveInputFocus
} from '../terminal/terminal-live-input'
import { sendMobileTerminalQueryReply } from '../terminal/mobile-terminal-query-reply'
import {
  buildTerminalSendParams,
  TERMINAL_INPUT_SEND_OPTIONS
} from '../terminal/terminal-send-request'
import {
  splitTerminalGestureInput,
  type TerminalGestureInputReport
} from '../terminal/terminal-gesture-input'
import {
  nextTerminalSendSequence,
  noteTerminalSendRoundTrip,
  restartTerminalSendStream,
  terminalSendSpacingMs,
  terminalSendWindow
} from '../terminal/terminal-send-sequence'
import {
  appendTerminalGestureInput,
  dropStaleTerminalGestureMovement,
  hasQueuedTerminalGestureClick,
  queuedTerminalGestureSequenceCount,
  takeTerminalGestureInputBatch
} from './terminal-gesture-input-queue'
import {
  isGestureMouseTrackingMode,
  TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY,
  TERMINAL_GESTURE_INPUT_FLUSH_DELAY_MS,
  TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES,
  TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS,
  TERMINAL_GESTURE_INPUT_MAX_QUEUED_SCROLL_REPORTS,
  TERMINAL_GESTURE_INPUT_REFILL_PER_SECOND
} from './mobile-session-route-helpers'
import type { Terminal } from './mobile-session-route-types'
import type { MobileSessionFileActionsModel } from './use-mobile-session-file-actions'

export function useMobileSessionTerminalInput(scope: MobileSessionFileActionsModel) {
  const {
    client,
    connState,
    toggleTerminalLiveInput,
    activeHandle,
    ptyModesRef,
    terminalGestureInputBucketsRef,
    terminalGestureInputQueuesRef,
    terminalGestureInputInFlightRef,
    terminalSendSequenceRef,
    deviceTokenRef,
    clientRef,
    connStateRef,
    liveInputRef,
    liveInputFocusTimerRef,
    terminalUnsubsRef,
    activeHandleRef,
    activeSessionTabTypeRef,
    clearPendingLiveInputCommit,
    showToast,
    getTerminalRef,
    hostQueryReplyInputSupportedRef
  } = scope
  const toggleLiveInput = useCallback(() => {
    if (!activeHandle) {
      return
    }
    const nextEnabled = toggleTerminalLiveInput(activeHandle)
    clearPendingLiveInputCommit()
    if (nextEnabled) {
      scheduleTerminalLiveInputFocus(liveInputFocusTimerRef, () => liveInputRef.current?.focus())
    } else {
      clearTerminalLiveInputFocusTimer(liveInputFocusTimerRef)
      liveInputRef.current?.blur()
    }
  }, [activeHandle, clearPendingLiveInputCommit, toggleTerminalLiveInput])

  const allowTerminalGestureInput = useCallback(
    (handle: string, sequenceCount: number): boolean => {
      const now = Date.now()
      const current = terminalGestureInputBucketsRef.current.get(handle) ?? {
        tokens: TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY,
        lastRefillMs: now
      }
      const elapsedSeconds = Math.max(0, now - current.lastRefillMs) / 1000
      const tokens = Math.min(
        TERMINAL_GESTURE_INPUT_BUCKET_CAPACITY,
        current.tokens + elapsedSeconds * TERMINAL_GESTURE_INPUT_REFILL_PER_SECOND
      )

      // Why: tokens count terminal control sequences, not WebView messages; one gesture may batch up to 32 wheel/key reports.
      if (tokens < sequenceCount) {
        terminalGestureInputBucketsRef.current.set(handle, { tokens, lastRefillMs: now })
        return false
      }

      terminalGestureInputBucketsRef.current.set(handle, {
        tokens: tokens - sequenceCount,
        lastRefillMs: now
      })
      return true
    },
    []
  )

  const sendTerminalGestureInputBatch = useCallback(
    async (handle: string, rpc: NonNullable<typeof clientRef.current>, bytes: string) => {
      const inFlight = terminalGestureInputInFlightRef.current.get(handle) ?? {
        count: 0,
        window: terminalSendWindow(terminalSendSequenceRef.current),
        lastSentAtMs: 0
      }
      const sentAtMs = Date.now()
      inFlight.count += 1
      inFlight.lastSentAtMs = sentAtMs
      terminalGestureInputInFlightRef.current.set(handle, inFlight)
      try {
        const response = await terminalInputSend.request(
          rpc,
          buildTerminalSendParams({
            terminal: handle,
            text: bytes,
            enter: false,
            deviceToken: deviceTokenRef.current,
            sequence: nextTerminalSendSequence(terminalSendSequenceRef.current, 'gestures', handle)
          }),
          TERMINAL_INPUT_SEND_OPTIONS
        )
        noteTerminalSendRoundTrip(terminalSendSequenceRef.current, Date.now() - sentAtMs)
        if (terminalInputSend.interpret(response) === true) {
          reportWorkerTerminalUserInput(rpc, handle)
        }
      } catch {
        // Transient failure
        restartTerminalSendStream(terminalSendSequenceRef.current, 'gestures', handle)
      } finally {
        // Why: a reconnect or a closed tab replaces the record; its sends no longer count.
        if (terminalGestureInputInFlightRef.current.get(handle) === inFlight) {
          inFlight.count -= 1
          if (inFlight.count === 0) {
            terminalGestureInputInFlightRef.current.delete(handle)
          }
        }
      }
    },
    []
  )

  const flushTerminalGestureInput = useCallback(
    async (handle: string) => {
      const queued = terminalGestureInputQueuesRef.current.get(handle)
      if (!queued) {
        return
      }
      if (queued.timer) {
        clearTimeout(queued.timer)
        queued.timer = null
      }
      const isActive =
        handle === activeHandleRef.current && activeSessionTabTypeRef.current === 'terminal'
      const rpc = clientRef.current
      // Why: gesture input parked across a reconnect would move a TUI long after the swipe.
      if (!rpc || connStateRef.current !== 'connected' || !isActive) {
        terminalGestureInputQueuesRef.current.delete(handle)
        return
      }

      const sends: Promise<void>[] = []
      for (;;) {
        dropStaleTerminalGestureMovement(
          queued,
          Date.now(),
          TERMINAL_GESTURE_INPUT_MAX_QUEUE_AGE_MS
        )
        if (queued.runs.length === 0) {
          terminalGestureInputQueuesRef.current.delete(handle)
          break
        }
        const inFlight = terminalGestureInputInFlightRef.current.get(handle)
        // Why: a send already out without a sequence number can be overtaken, so the window only widens once nothing is outstanding.
        const window = inFlight?.window ?? terminalSendWindow(terminalSendSequenceRef.current)
        // Why: a click is sent at once even past the window; the host applies it after the scroll sends ahead of it.
        const clickWaiting = window > 1 && hasQueuedTerminalGestureClick(queued)
        if ((inFlight?.count ?? 0) >= window && !clickWaiting) {
          break
        }
        const paceMs = inFlight
          ? inFlight.lastSentAtMs +
            terminalSendSpacingMs(terminalSendSequenceRef.current) -
            Date.now()
          : 0
        if (paceMs > 0 && !clickWaiting) {
          queued.timer = setTimeout(() => {
            queued.timer = null
            void flushTerminalGestureInput(handle)
          }, paceMs)
          break
        }
        const bytes = takeTerminalGestureInputBatch(
          queued,
          TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES
        )
        sends.push(
          sendTerminalGestureInputBatch(handle, rpc, bytes).then(() => {
            if (terminalGestureInputQueuesRef.current.has(handle)) {
              return flushTerminalGestureInput(handle)
            }
            return undefined
          })
        )
      }
      await Promise.all(sends)
    },
    [sendTerminalGestureInputBatch]
  )

  const enqueueTerminalGestureInput = useCallback(
    (handle: string, reports: readonly TerminalGestureInputReport[]) => {
      let queued = terminalGestureInputQueuesRef.current.get(handle)
      if (!queued) {
        queued = { runs: [], timer: null }
        terminalGestureInputQueuesRef.current.set(handle, queued)
      }
      appendTerminalGestureInput(
        queued,
        reports,
        Date.now(),
        TERMINAL_GESTURE_INPUT_MAX_QUEUED_SCROLL_REPORTS
      )
      // Why: a click must not sit out the debounce or a pacing delay meant for scroll sends.
      if (
        reports.some((report) => report.kind === 'click') ||
        queuedTerminalGestureSequenceCount(queued) >= TERMINAL_GESTURE_INPUT_MAX_PENDING_SEQUENCES
      ) {
        void flushTerminalGestureInput(handle)
        return
      }
      if (!queued.timer) {
        const pending = queued
        pending.timer = setTimeout(() => {
          pending.timer = null
          void flushTerminalGestureInput(handle)
        }, TERMINAL_GESTURE_INPUT_FLUSH_DELAY_MS)
      }
    },
    [flushTerminalGestureInput]
  )

  const handleTerminalInput = useCallback(
    async (handle: string, bytes: string) => {
      if (!client || connState !== 'connected' || bytes.length === 0) {
        return
      }
      if (handle !== activeHandleRef.current || activeSessionTabTypeRef.current !== 'terminal') {
        return
      }
      const modes = ptyModesRef.current.get(handle)
      // Why: WebView gesture bytes can become PTY input, so gate mouse reports behind validation and SSH-safe rate limiting.
      if (!modes?.altScreen && !isGestureMouseTrackingMode(modes?.mouseTrackingMode)) {
        return
      }
      const reports = splitTerminalGestureInput(bytes)
      if (reports == null) {
        return
      }
      if (!allowTerminalGestureInput(handle, reports.length)) {
        return
      }
      enqueueTerminalGestureInput(handle, reports)
    },
    [allowTerminalGestureInput, client, connState, enqueueTerminalGestureInput]
  )

  const handleTerminalQueryReply = useCallback((handle: string, bytes: string) => {
    void sendMobileTerminalQueryReply({
      bytes,
      client: clientRef.current,
      clientId: deviceTokenRef.current,
      connected: connStateRef.current === 'connected',
      handle,
      hostSupportsQueryReplyInput: hostQueryReplyInputSupportedRef.current,
      subscribedTerminals: terminalUnsubsRef.current
    })
  }, [])

  async function handleClearTerminal(target: Terminal) {
    if (!client) {
      return
    }
    getTerminalRef(target.handle)?.clear()
    try {
      // The reply is unread: main toasted success on any fulfilled envelope, refusal included.
      await terminalBufferClear.request(client, { terminal: target.handle })
      showToast('Terminal cleared')
    } catch {
      showToast("Couldn't clear terminal", 1500)
    }
  }
  return {
    toggleLiveInput,
    allowTerminalGestureInput,
    flushTerminalGestureInput,
    enqueueTerminalGestureInput,
    handleTerminalInput,
    handleTerminalQueryReply,
    handleClearTerminal
  }
}

export type MobileSessionTerminalInputModel = MobileSessionFileActionsModel &
  ReturnType<typeof useMobileSessionTerminalInput>
