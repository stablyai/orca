const LINE_EDITOR_READY_SEQUENCES = ['\x1b[?2004h', '\x1b[?1034h', '\x1b]133;A\x07'] as const
const MAX_SEQUENCE_LENGTH = Math.max(...LINE_EDITOR_READY_SEQUENCES.map((value) => value.length))

export type LineEditorReadyOutputScanState = {
  tail: string
}

export function createLineEditorReadyOutputScanState(): LineEditorReadyOutputScanState {
  return { tail: '' }
}

export function scanForLineEditorReadyOutput(
  state: LineEditorReadyOutputScanState,
  data: string
): boolean {
  const combined = state.tail + data
  state.tail = combined.slice(-(MAX_SEQUENCE_LENGTH - 1))
  return LINE_EDITOR_READY_SEQUENCES.some((sequence) => combined.includes(sequence))
}
