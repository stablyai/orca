import { useCallback, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import {
  getTerminalLiveAccessoryBytesDecision,
  getTerminalLiveAccessoryLocalEditText,
  getTerminalLiveDeferredTextDelayMs
} from './terminal-live-text-commit'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'

export type TerminalLiveAccessoryInputCommitResult =
  | { readonly kind: 'allow-raw' }
  | { readonly kind: 'handled' }
  | { readonly kind: 'suppress-raw' }

type TerminalLiveInputCommitScheduler = (
  handle: string,
  text: string,
  delayMs: number | null
) => void

export async function getTerminalLiveAccessoryInactiveInputCommitResult(
  waitForPendingLiveInputFlush: () => Promise<boolean>
): Promise<TerminalLiveAccessoryInputCommitResult> {
  return (await waitForPendingLiveInputFlush()) ? { kind: 'allow-raw' } : { kind: 'suppress-raw' }
}

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
) => Promise<TerminalLiveAccessoryInputCommitResult> {
  return useCallback(
    async (input: TerminalLiveAccessoryInput): Promise<TerminalLiveAccessoryInputCommitResult> => {
      if (!activeHandle) {
        return { kind: 'allow-raw' }
      }
      if (!liveInputTerminalHandles.has(activeHandle)) {
        return getTerminalLiveAccessoryInactiveInputCommitResult(waitForPendingLiveInputFlush)
      }
      const pendingText =
        pendingLiveInputHandleRef.current === activeHandle ? pendingLiveInputTextRef.current : ''
      if (pendingLiveInputHandleRef.current && pendingLiveInputHandleRef.current !== activeHandle) {
        clearPendingLiveInputCommit()
      }
      const decision = getTerminalLiveAccessoryBytesDecision({ ...input, pendingText })
      switch (decision.kind) {
        case 'send-now':
          // Why: raw accessory bytes must wait behind any in-flight IME text
          // flush so composed Hangul reaches the PTY before follow-up controls.
          return (await waitForPendingLiveInputFlush())
            ? { kind: 'allow-raw' }
            : { kind: 'suppress-raw' }
        case 'local-edit': {
          const editedText = getTerminalLiveAccessoryLocalEditText({
            localEdit: decision.localEdit,
            pendingText
          })
          if (editedText.length === 0) {
            clearPendingLiveInputCommit()
            return { kind: 'handled' }
          }
          // Why: accessory buttons do not emit native TextInput edits, so the
          // pending IME buffer must be edited and rescheduled here.
          setLiveInputCapture(editedText)
          liveInputRef.current?.setNativeProps({ text: editedText })
          schedulePendingLiveInputCommit(
            activeHandle,
            editedText,
            getTerminalLiveDeferredTextDelayMs(editedText)
          )
          return { kind: 'handled' }
        }
        case 'flush-then-send':
          await sendTerminalLiveControlAfterPendingFlush(
            () => flushPendingLiveInputText(activeHandle),
            () => sendLiveTerminalInputRef.current(activeHandle, decision.bytes)
          )
          return { kind: 'handled' }
        default:
          decision satisfies never
          return { kind: 'handled' }
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
