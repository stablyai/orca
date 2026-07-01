import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import {
  queueTerminalLivePendingFlush,
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

type TerminalLivePendingInputFlush = {
  readonly clearPendingLiveInputCommit: () => void
  readonly flushPendingLiveInputText: (expectedHandle: string | null) => Promise<boolean>
  readonly pendingLiveInputHandleRef: RefObject<string | null>
  readonly pendingLiveInputTextRef: RefObject<string>
  readonly schedulePendingLiveInputCommit: (
    handle: string,
    text: string,
    delayMs: number | null
  ) => void
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
  const liveInputCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingLiveInputFlushRef = useRef<Promise<boolean> | null>(null)
  const pendingLiveInputTextRef = useRef('')
  const pendingLiveInputHandleRef = useRef<string | null>(null)

  const clearPendingLiveInputCommit = useCallback(() => {
    if (liveInputCommitTimerRef.current) {
      clearTimeout(liveInputCommitTimerRef.current)
      liveInputCommitTimerRef.current = null
    }
    pendingLiveInputTextRef.current = ''
    pendingLiveInputHandleRef.current = null
    setLiveInputCapture('')
    liveInputRef.current?.setNativeProps({ text: '' })
  }, [liveInputRef, setLiveInputCapture])

  const waitForPendingLiveInputFlush = useCallback(async (): Promise<boolean> => {
    return waitForTerminalLivePendingFlush(pendingLiveInputFlushRef)
  }, [])

  const flushPendingLiveInputText = useCallback(
    async (expectedHandle: string | null): Promise<boolean> => {
      const existingFlush = pendingLiveInputFlushRef.current
      if (liveInputCommitTimerRef.current) {
        clearTimeout(liveInputCommitTimerRef.current)
        liveInputCommitTimerRef.current = null
      }

      const handle = pendingLiveInputHandleRef.current
      const text = pendingLiveInputTextRef.current
      pendingLiveInputHandleRef.current = null
      pendingLiveInputTextRef.current = ''
      setLiveInputCapture('')
      liveInputRef.current?.setNativeProps({ text: '' })

      if (!handle || text.length === 0) {
        return existingFlush ?? false
      }
      if (
        (expectedHandle !== null && handle !== expectedHandle) ||
        handle !== activeHandleRef.current ||
        activeSessionTabTypeRef.current !== 'terminal' ||
        !liveInputTerminalHandlesRef.current.has(handle)
      ) {
        return false
      }

      return queueTerminalLivePendingFlush(pendingLiveInputFlushRef, () =>
        sendLiveTerminalInputRef.current(handle, text)
      )
    },
    [
      activeHandleRef,
      activeSessionTabTypeRef,
      liveInputRef,
      liveInputTerminalHandlesRef,
      sendLiveTerminalInputRef,
      setLiveInputCapture
    ]
  )

  const schedulePendingLiveInputCommit = useCallback(
    (handle: string, text: string, delayMs: number | null) => {
      if (liveInputCommitTimerRef.current) {
        clearTimeout(liveInputCommitTimerRef.current)
      }
      pendingLiveInputHandleRef.current = handle
      pendingLiveInputTextRef.current = text
      if (delayMs === null) {
        liveInputCommitTimerRef.current = null
        return
      }
      liveInputCommitTimerRef.current = setTimeout(() => {
        liveInputCommitTimerRef.current = null
        void flushPendingLiveInputText(handle)
      }, delayMs)
    },
    [flushPendingLiveInputText]
  )

  useEffect(() => {
    return () => {
      if (liveInputCommitTimerRef.current) {
        clearTimeout(liveInputCommitTimerRef.current)
        liveInputCommitTimerRef.current = null
      }
      pendingLiveInputHandleRef.current = null
      pendingLiveInputTextRef.current = ''
      pendingLiveInputFlushRef.current = null
    }
  }, [])

  return {
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    pendingLiveInputHandleRef,
    pendingLiveInputTextRef,
    schedulePendingLiveInputCommit,
    waitForPendingLiveInputFlush
  }
}
