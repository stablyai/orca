import { useCallback, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import {
  getTerminalLiveAccessoryBytesDecision,
  getTerminalLiveAccessoryLocalEditText
} from './terminal-live-text-commit'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import type { TerminalLiveQueueControlOptions } from './terminal-live-control-payload'

export type TerminalLiveAccessoryInputCommitResult =
  | { readonly kind: 'allow-raw' }
  | { readonly kind: 'handled' }
  | { readonly kind: 'suppress-raw' }

export async function getTerminalLiveAccessoryInactiveInputCommitResult(
  waitForPendingLiveInputFlush: () => Promise<boolean>
): Promise<TerminalLiveAccessoryInputCommitResult> {
  return (await waitForPendingLiveInputFlush()) ? { kind: 'allow-raw' } : { kind: 'suppress-raw' }
}

type TerminalLiveAccessoryInputCommitOptions = {
  readonly activeHandle: string | null
  readonly applyLiveInputMirror: (handle: string, fieldText: string) => void
  readonly clearPendingLiveInputCommit: () => void
  readonly heldLiveInputTextRef: RefObject<string>
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly pendingLiveInputHandleRef: RefObject<string | null>
  readonly queueLiveInputControl: (
    handle: string,
    bytes: string,
    options: TerminalLiveQueueControlOptions
  ) => Promise<boolean>
  readonly sentLiveInputTextRef: RefObject<string>
  readonly setLiveInputCapture: (text: string) => void
  readonly waitForPendingLiveInputFlush: () => Promise<boolean>
}

export function useTerminalLiveAccessoryInputCommit({
  activeHandle,
  applyLiveInputMirror,
  clearPendingLiveInputCommit,
  heldLiveInputTextRef,
  liveInputRef,
  liveInputTerminalHandles,
  pendingLiveInputHandleRef,
  queueLiveInputControl,
  sentLiveInputTextRef,
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
      const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
      if (pendingLiveInputHandleRef.current && !ownsPendingState) {
        clearPendingLiveInputCommit()
      }
      const heldText = ownsPendingState ? heldLiveInputTextRef.current : ''
      const sentText = ownsPendingState ? sentLiveInputTextRef.current : ''
      const decision = getTerminalLiveAccessoryBytesDecision({ ...input, heldText, sentText })
      switch (decision.kind) {
        case 'send-now':
        case 'commit-held-then-send': {
          const bytes = decision.kind === 'send-now' ? input.bytes : decision.bytes
          if (heldText.length > 0 || sentText.length > 0) {
            // Queue on the mirror chain, then clear the old session synchronously so a
            // following onChange starts fresh and chains behind this control payload.
            const sendPromise = queueLiveInputControl(activeHandle, bytes, {
              commitFieldBeforeControl: heldText.length > 0
            })
            clearPendingLiveInputCommit()
            await sendPromise
            return { kind: 'handled' }
          }
          return (await waitForPendingLiveInputFlush())
            ? { kind: 'allow-raw' }
            : { kind: 'suppress-raw' }
        }
        case 'local-edit': {
          const editedText = getTerminalLiveAccessoryLocalEditText({
            localEdit: decision.localEdit,
            fieldText: sentText + heldText
          })
          // Why: accessory buttons do not emit native TextInput edits, so the
          // field is edited here and the mirror diff syncs the PTY echo.
          setLiveInputCapture(editedText)
          liveInputRef.current?.setNativeProps({ text: editedText })
          applyLiveInputMirror(activeHandle, editedText)
          return { kind: 'handled' }
        }
        default:
          decision satisfies never
          return { kind: 'handled' }
      }
    },
    [
      activeHandle,
      applyLiveInputMirror,
      clearPendingLiveInputCommit,
      heldLiveInputTextRef,
      liveInputRef,
      liveInputTerminalHandles,
      pendingLiveInputHandleRef,
      queueLiveInputControl,
      sentLiveInputTextRef,
      setLiveInputCapture,
      waitForPendingLiveInputFlush
    ]
  )
}
