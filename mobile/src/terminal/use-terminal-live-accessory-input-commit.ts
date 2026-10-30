import { useCallback, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import {
  getTerminalLiveAccessoryBytesDecision,
  getTerminalLiveAccessoryLocalEditText,
  terminalLiveAccessoryInputEndsLine,
  type TerminalLiveInputSelection
} from './terminal-live-text-commit'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import { writeTerminalLiveInputText } from './terminal-live-input-text-write'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'

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
  readonly endLiveInputSessionThenSend: (handle: string, bytes: string) => Promise<boolean>
  readonly heldLiveInputTextRef: RefObject<string>
  readonly liveInputComposingRef: RefObject<boolean | undefined>
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTextRef: RefObject<string>
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly onInteraction: () => void
  readonly pendingLiveInputHandleRef: RefObject<string | null>
  readonly queueLiveInputControl: (handle: string, bytes: string) => Promise<boolean>
  readonly sentLiveInputTextRef: RefObject<string>
  readonly setLiveInputCapture: (text: string) => void
  readonly waitForPendingLiveInputFlush: () => Promise<boolean>
}

// The RN-Web ref is the field itself, so its caret is current even when an edit kept the offsets
// and fired no selection event; native refs expose no caret, so edit at the end.
export function readLiveInputSelection(
  node: TextInput | null,
  fieldText: string
): TerminalLiveInputSelection | null {
  if (
    !node ||
    !('selectionStart' in node) ||
    !('selectionEnd' in node) ||
    typeof node.selectionStart !== 'number' ||
    typeof node.selectionEnd !== 'number'
  ) {
    return { start: fieldText.length, end: fieldText.length }
  }
  // A field that no longer holds the mirrored text would delete at an unrelated offset.
  if (!('value' in node) || node.value !== fieldText) {
    return null
  }
  return { start: node.selectionStart, end: node.selectionEnd }
}

/** Keeps accessory edits local and orders terminal controls after pending text has been sent. */
export function useTerminalLiveAccessoryInputCommit({
  activeHandle,
  applyLiveInputMirror,
  clearPendingLiveInputCommit,
  endLiveInputSessionThenSend,
  heldLiveInputTextRef,
  liveInputComposingRef,
  liveInputRef,
  liveInputTextRef,
  liveInputTerminalHandles,
  onInteraction,
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
      onInteraction()
      const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
      if (pendingLiveInputHandleRef.current && !ownsPendingState) {
        clearPendingLiveInputCommit()
      }
      const heldText = ownsPendingState ? heldLiveInputTextRef.current : ''
      const sentText = ownsPendingState ? sentLiveInputTextRef.current : ''
      const decision = getTerminalLiveAccessoryBytesDecision({ ...input, heldText, sentText })
      switch (decision.kind) {
        case 'send-now': {
          // Line-ending controls also end the field session so later input cannot reuse stale text.
          const sent = await (terminalLiveAccessoryInputEndsLine(input.bytes)
            ? endLiveInputSessionThenSend(activeHandle, input.bytes)
            : queueLiveInputControl(activeHandle, input.bytes))
          return sent ? { kind: 'handled' } : { kind: 'suppress-raw' }
        }
        case 'local-edit': {
          const fieldText = liveInputTextRef.current
          const selection = readLiveInputSelection(liveInputRef.current, fieldText)
          if (!selection) {
            return { kind: 'suppress-raw' }
          }
          const editedText = getTerminalLiveAccessoryLocalEditText({
            localEdit: decision.localEdit,
            fieldText,
            selection
          })
          const start = Math.max(0, Math.min(selection.start, fieldText.length))
          const cursor =
            decision.localEdit === 'backspace' && selection.start === selection.end
              ? start - (fieldText.length - editedText.length)
              : start
          const nextSelection = { start: cursor, end: cursor }
          // Accessory buttons emit no native edits; change the field so mirror diffs synchronize PTY echo.
          setLiveInputCapture(editedText)
          writeTerminalLiveInputText(liveInputRef, editedText, nextSelection)
          // Undefined composition enables Android’s timed heuristic hold.
          const sent = await applyLiveInputMirror(
            activeHandle,
            normalizeTerminalTextInput(editedText),
            liveInputComposingRef.current
          )
          return sent ? { kind: 'handled' } : { kind: 'suppress-raw' }
        }
        case 'commit-held-then-send': {
          const sent = await endLiveInputSessionThenSend(activeHandle, decision.bytes)
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
      endLiveInputSessionThenSend,
      heldLiveInputTextRef,
      liveInputComposingRef,
      liveInputRef,
      liveInputTextRef,
      liveInputTerminalHandles,
      onInteraction,
      pendingLiveInputHandleRef,
      queueLiveInputControl,
      sentLiveInputTextRef,
      setLiveInputCapture,
      waitForPendingLiveInputFlush
    ]
  )
}
