import { useCallback, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import {
  TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS,
  getTerminalLiveAccessoryBytesDecision,
  getTerminalLiveAccessoryLocalEditText,
  type TerminalLiveAccessoryLocalEdit
} from './terminal-live-text-commit'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'

export type TerminalLiveAccessoryInput = {
  readonly bytes: string
  readonly localEdit?: TerminalLiveAccessoryLocalEdit
}

type TerminalLiveInputCommitScheduler = (handle: string, text: string, delayMs: number) => void

type TerminalLiveAccessoryInputCommitOptions = {
  readonly activeHandle: string | null
  readonly clearPendingLiveInputCommit: () => void
  readonly flushPendingLiveInputText: (expectedHandle: string | null) => Promise<boolean>
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly pendingLiveInputHandleRef: RefObject<string | null>
  readonly pendingLiveInputTextRef: RefObject<string>
  readonly schedulePendingLiveInputCommit: TerminalLiveInputCommitScheduler
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
  readonly waitForPendingLiveInputFlush: () => Promise<boolean>
}

export function useTerminalLiveAccessoryInputCommit({
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
}: TerminalLiveAccessoryInputCommitOptions): (
  input: TerminalLiveAccessoryInput
) => Promise<boolean> {
  return useCallback(
    async (input: TerminalLiveAccessoryInput): Promise<boolean> => {
      if (!activeHandle) {
        return false
      }
      if (!liveInputTerminalHandles.has(activeHandle)) {
        return false
      }
      const pendingText =
        pendingLiveInputHandleRef.current === activeHandle ? pendingLiveInputTextRef.current : ''
      if (pendingLiveInputHandleRef.current && pendingLiveInputHandleRef.current !== activeHandle) {
        clearPendingLiveInputCommit()
      }
      const decision = getTerminalLiveAccessoryBytesDecision({ ...input, pendingText })
      switch (decision.kind) {
        case 'send-now':
          return !(await waitForPendingLiveInputFlush())
        case 'local-edit': {
          const editedText = getTerminalLiveAccessoryLocalEditText({
            localEdit: decision.localEdit,
            pendingText
          })
          if (editedText.length === 0) {
            clearPendingLiveInputCommit()
            return true
          }
          // Why: accessory buttons do not emit native TextInput edits, so the
          // pending IME buffer must be edited and rescheduled here.
          setLiveInputCapture(editedText)
          liveInputRef.current?.setNativeProps({ text: editedText })
          schedulePendingLiveInputCommit(
            activeHandle,
            editedText,
            TERMINAL_LIVE_TEXT_COMMIT_DELAY_MS
          )
          return true
        }
        case 'flush-then-send':
          await sendTerminalLiveControlAfterPendingFlush(
            () => flushPendingLiveInputText(activeHandle),
            () => sendLiveTerminalInputRef.current(activeHandle, decision.bytes)
          )
          return true
        default:
          decision satisfies never
          return true
      }
    },
    [
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
    ]
  )
}
