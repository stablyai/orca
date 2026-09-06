import { describe, expect, it } from 'vitest'
import { readMobileSessionRouteSource } from '../session/mobile-session-route-source-family.test-support'

const commandDockSource = readMobileSessionRouteSource('../session/MobileSessionCommandDock.tsx')
const sendActionsSource = readMobileSessionRouteSource(
  '../session/use-mobile-session-terminal-send-actions.ts'
)

// Why: iOS terminates an active keyboard-dictation (and IME) session whenever
// JS writes a value into the focused field that differs from the native text
// (RN applies it via setTextAndSelection / _setAttributedString). Terminal
// inputs therefore must echo the raw field text in their controlled value and
// apply dash normalization only on the send/mirror path. See stablyai/orca#7925.
describe('terminal iOS dictation write-back', () => {
  it('does not write normalized text back into the buffered command input value', () => {
    expect(commandDockSource).toContain('onChangeText={bufferedTerminalDraftState.setInput}')
    expect(commandDockSource).not.toContain('setInput((previousText) => normalizeTerminalTextInput')
  })

  it('still normalizes the buffered command text at send time', () => {
    expect(sendActionsSource).toContain('normalizeTerminalTextInput(draft)')
  })
})
