import { describe, expect, it } from 'vitest'
import {
  appendTerminalPromptTail,
  extractTerminalPromptCandidateLine,
  isTerminalPasswordPromptText,
  maskTerminalLiveInputText,
  resolveTerminalInputMaskedState,
  stripTerminalPromptAnsi
} from './terminal-password-prompt'

describe('terminal-password-prompt', () => {
  it('strips ANSI CSI and OSC escape sequences from prompt tails', () => {
    const raw =
      '\u001b]0;aleksei@HP: ~\u0007\u001b[1m   [confirm] sudo password for aleksei: \u001b[0m'
    expect(stripTerminalPromptAnsi(raw)).toBe('   [confirm] sudo password for aleksei: ')
    expect(extractTerminalPromptCandidateLine(raw)).toBe('   [confirm] sudo password for aleksei: ')
  })

  it('detects sudo, ssh, passphrase, PIN, and verification code prompts', () => {
    expect(isTerminalPasswordPromptText('   [confirm] sudo password for aleksei: ')).toBe(true)
    expect(isTerminalPasswordPromptText('[sudo] password for ubuntu: ')).toBe(true)
    expect(isTerminalPasswordPromptText('Password:')).toBe(true)
    expect(
      isTerminalPasswordPromptText("Enter passphrase for key '/home/aleksei/.ssh/id_ed25519': ")
    ).toBe(true)
    expect(isTerminalPasswordPromptText('Enter PIN for YubiKey: ')).toBe(true)
    expect(isTerminalPasswordPromptText('Verification code: ')).toBe(true)
  })

  it('does not flag normal shell prompts or completed password lines', () => {
    expect(isTerminalPasswordPromptText('aleksei@HP:~/Projects/w0m$ ')).toBe(false)
    expect(
      isTerminalPasswordPromptText('   [confirm] sudo password for aleksei: \n✅ confirmed\n$ ')
    ).toBe(false)
    expect(isTerminalPasswordPromptText('echo "password: value"\n')).toBe(false)
  })

  it('bounds the rolling prompt tail buffer', () => {
    const prefix = 'x'.repeat(600)
    const tail = appendTerminalPromptTail(prefix, '\nPassword: ')
    expect(tail.length).toBeLessThanOrEqual(512)
    expect(isTerminalPasswordPromptText(tail)).toBe(true)
  })

  it('masks typed characters with one asterisk per Unicode code point', () => {
    expect(maskTerminalLiveInputText('')).toBe('')
    expect(maskTerminalLiveInputText('oiu')).toBe('***')
    expect(maskTerminalLiveInputText('päss')).toBe('****')
  })

  it('resolves masked state with manual show/hide override taking precedence over auto detection', () => {
    expect(
      resolveTerminalInputMaskedState({ autoDetectedPrompt: false, manualOverride: undefined })
    ).toBe(false)
    expect(
      resolveTerminalInputMaskedState({ autoDetectedPrompt: true, manualOverride: undefined })
    ).toBe(true)
    expect(
      resolveTerminalInputMaskedState({ autoDetectedPrompt: true, manualOverride: false })
    ).toBe(false)
    expect(
      resolveTerminalInputMaskedState({ autoDetectedPrompt: false, manualOverride: true })
    ).toBe(true)
  })
})
