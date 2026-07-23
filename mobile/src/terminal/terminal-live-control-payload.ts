import {
  planTerminalLiveFieldTextChange,
  type TerminalLiveSelectionCursorState
} from './terminal-live-selection-cursor'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'

export type TerminalLiveQueueControlOptions = {
  readonly commitFieldBeforeControl: boolean
}

/** Snapshot restore/held-commit bytes for a control that ends the field session. */
export function buildTerminalLiveFieldCommitPrefix(
  state: TerminalLiveSelectionCursorState
): string {
  const fieldText = state.sentText + state.heldText
  return planTerminalLiveFieldTextChange(state, fieldText, null, {
    normalize: normalizeTerminalTextInput,
    commitHeld: true
  }).payload
}

export function buildTerminalLiveQueuedControlPayload(options: {
  readonly state: TerminalLiveSelectionCursorState
  readonly ownsFieldState: boolean
  readonly commitFieldBeforeControl: boolean
  readonly controlBytes: string
}): string {
  if (!options.commitFieldBeforeControl || !options.ownsFieldState) {
    return options.controlBytes
  }
  return buildTerminalLiveFieldCommitPrefix(options.state) + options.controlBytes
}
