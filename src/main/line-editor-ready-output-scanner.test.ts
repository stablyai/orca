import { describe, expect, it } from 'vitest'
import {
  createLineEditorReadyOutputScanState,
  scanForLineEditorReadyOutput
} from './line-editor-ready-output-scanner'

describe('line editor ready output scanner', () => {
  it.each(['\x1b[?2004h', '\x1b[?1034h'])('detects %j across chunks', (sequence) => {
    const state = createLineEditorReadyOutputScanState()
    expect(scanForLineEditorReadyOutput(state, `prompt${sequence.slice(0, 4)}`)).toBe(false)
    expect(scanForLineEditorReadyOutput(state, sequence.slice(4))).toBe(true)
  })

  it('ignores ordinary prompt output', () => {
    expect(
      scanForLineEditorReadyOutput(createLineEditorReadyOutputScanState(), 'user@host % ')
    ).toBe(false)
  })
})
