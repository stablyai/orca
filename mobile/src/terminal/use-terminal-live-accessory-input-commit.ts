import { useCallback, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import {
  getTerminalLiveAccessoryBytesDecision,
  getTerminalLiveAccessoryLocalEditText
} from './terminal-live-text-commit'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'

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
  readonly applyLiveInputMirror: (
    handle: string,
    fieldText: string,
    composing?: boolean
  ) => Promise<boolean>
  readonly clearPendingLiveInputCommit: () => void
  readonly queueLiveInputControl: (handle: string, bytes: string) => Promise<boolean>
  readonly heldLiveInputTextRef: RefObject<string>
  readonly liveInputComposingRef: RefObject<boolean | undefined>
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly onInteraction: () => void
  readonly pendingLiveInputHandleRef: RefObject<string | null>
  readonly sentLiveInputTextRef: RefObject<string>
  readonly setLiveInputCapture: (text: string) => void
  readonly waitForPendingLiveInputFlush: () => Promise<boolean>
}

export function useTerminalLiveAccessoryInputCommit({
  activeHandle,
  applyLiveInputMirror,
  clearPendingLiveInputCommit,
  queueLiveInputControl,
  heldLiveInputTextRef,
  liveInputComposingRef,
  liveInputRef,
  liveInputTerminalHandles,
  onInteraction,
  pendingLiveInputHandleRef,
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
      onInteraction()
      const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
      if (pendingLiveInputHandleRef.current && !ownsPendingState) {
        clearPendingLiveInputCommit()
      }
      const heldText = ownsPendingState ? heldLiveInputTextRef.current : ''
      const sentText = ownsPendingState ? sentLiveInputTextRef.current : ''
      const decision = getTerminalLiveAccessoryBytesDecision({ ...input, heldText, sentText })
      switch (decision.kind) {
        case 'send-now':
          return (await queueLiveInputControl(activeHandle, decision.bytes))
            ? { kind: 'handled' }
            : { kind: 'suppress-raw' }
        case 'local-edit': {
          const editedText = getTerminalLiveAccessoryLocalEditText({
            localEdit: decision.localEdit,
            fieldText: sentText + heldText
          })
          // Why: accessory buttons do not emit native TextInput edits, so the
          // field is edited here and the mirror diff syncs the PTY echo.
          setLiveInputCapture(editedText)
          liveInputRef.current?.setNativeProps({ text: editedText })
          // Preserve undefined so Android's heuristic hold still settles on its timer.
          const sent = await applyLiveInputMirror(
            activeHandle,
            editedText,
            liveInputComposingRef.current
          )
          return sent ? { kind: 'handled' } : { kind: 'suppress-raw' }
        }
        case 'commit-held-then-send': {
          const sent = await queueLiveInputControl(activeHandle, decision.bytes)
          return sent ? { kind: 'handled' } : { kind: 'suppress-raw' }
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
      queueLiveInputControl,
      heldLiveInputTextRef,
      liveInputComposingRef,
      liveInputRef,
      liveInputTerminalHandles,
      onInteraction,
      pendingLiveInputHandleRef,
      sentLiveInputTextRef,
      setLiveInputCapture,
      waitForPendingLiveInputFlush
    ]
  )
}
