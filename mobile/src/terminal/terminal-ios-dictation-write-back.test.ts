import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sessionRouteSource = readFileSync(
  new URL('../../app/h/[hostId]/session/[worktreeId].tsx', import.meta.url),
  'utf8'
)
// Why: the buffered command TextInput this guards lives in this extracted
// component, not the session route.
const inputBarSource = readFileSync(
  new URL('../session/terminal-session-input-bar.tsx', import.meta.url),
  'utf8'
)
const combinedSource = sessionRouteSource + inputBarSource

// Why: iOS terminates an active keyboard-dictation (and IME) session whenever
// JS writes a value into the focused field that differs from the native text
// (RN applies it via setTextAndSelection / _setAttributedString). Terminal
// inputs therefore must echo the raw field text in their controlled value and
// apply dash normalization only on the send/mirror path. See stablyai/orca#7925.
describe('terminal iOS dictation write-back', () => {
  it('does not write normalized text back into the buffered command input value', () => {
    expect(combinedSource).toContain('onChangeText={setInput}')
    expect(combinedSource).not.toContain('setInput((previousText) => normalizeTerminalTextInput')
  })

  it('still normalizes the buffered command text at send time', () => {
    expect(combinedSource).toContain('normalizeTerminalTextInput(input)')
  })

  it('leaves buffered autocorrection native and remounts Android when it changes', () => {
    expect(combinedSource).toContain('onChangeText={setInput}')
    expect(combinedSource).toContain('autoCorrect={autocompleteEnabled}')
    expect(combinedSource).toContain('spellCheck={autocompleteEnabled}')
    expect(combinedSource).toContain("? 'cmd-input-ac-on'")
    expect(combinedSource).toContain(": 'cmd-input-ac-off'")
  })
})
