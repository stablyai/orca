import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sessionRouteSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)

// Why: iOS terminates an active keyboard-dictation (and IME) session whenever
// JS writes a value into the focused field that differs from the native text
// (RN applies it via setTextAndSelection / _setAttributedString). Terminal
// inputs therefore must echo the raw field text in their controlled value and
// apply dash normalization only on the send/mirror path. See stablyai/orca#7925.
describe('terminal iOS dictation write-back', () => {
  it('does not write normalized text back into the buffered command input value', () => {
    expect(sessionRouteSource).toContain('onChangeText={setInput}')
    expect(sessionRouteSource).not.toContain(
      'setInput((previousText) => normalizeTerminalTextInput'
    )
  })

  it('still normalizes the buffered command text at send time', () => {
    expect(sessionRouteSource).toContain('normalizeTerminalTextInput(input)')
  })
})
