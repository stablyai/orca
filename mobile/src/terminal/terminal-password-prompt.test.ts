import { describe, expect, it } from 'vitest'
import {
  appendTerminalPromptTail,
  extractTerminalPromptCandidateLine,
  isTerminalPasswordPromptText,
  maskTerminalLiveInputText,
  reconcileTerminalManualMaskOverride,
  resolveTerminalInputMaskedState,
  stripTerminalPromptAnsi
} from './terminal-password-prompt'

describe('terminal-password-prompt', () => {
  it('strips ANSI CSI and OSC escape sequences from prompt tails', () => {
    const raw =
      '\u001b]0;dev@workstation: ~\u0007\u001b[1m   [confirm] sudo password for dev: \u001b[0m'
    expect(stripTerminalPromptAnsi(raw)).toBe('   [confirm] sudo password for dev: ')
    expect(extractTerminalPromptCandidateLine(raw)).toBe('   [confirm] sudo password for dev: ')
  })

  it('detects sudo, ssh, passphrase, URL/Windows targets with colons, PIN, and verification code prompts', () => {
    expect(isTerminalPasswordPromptText('   [confirm] sudo password for dev: ')).toBe(true)
    expect(isTerminalPasswordPromptText('[sudo] password for ubuntu: ')).toBe(true)
    expect(isTerminalPasswordPromptText('Password:')).toBe(true)
    expect(isTerminalPasswordPromptText("Password for 'https://github.com': ")).toBe(true)
    expect(isTerminalPasswordPromptText("Password for 'https://user@host:8443': ")).toBe(true)
    expect(
      isTerminalPasswordPromptText("Enter passphrase for key '/home/dev/.ssh/id_ed25519': ")
    ).toBe(true)
    expect(
      isTerminalPasswordPromptText("Enter passphrase for key 'C:\\Users\\me\\.ssh\\id_ed25519': ")
    ).toBe(true)
    expect(isTerminalPasswordPromptText('Enter PIN for YubiKey: ')).toBe(true)
    expect(isTerminalPasswordPromptText('PIN: ')).toBe(true)
    expect(isTerminalPasswordPromptText('Verification code: ')).toBe(true)
  })

  it('does not flag normal shell prompts or completed password lines', () => {
    expect(isTerminalPasswordPromptText('dev@workstation:~/Projects/app$ ')).toBe(false)
    expect(
      isTerminalPasswordPromptText('   [confirm] sudo password for dev: \n✅ confirmed\n$ ')
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

  it('resolves masked state with manual show/hide override taking precedence over auto detection and expiring Show when prompt ends', () => {
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
      reconcileTerminalManualMaskOverride({ autoDetectedPrompt: false, manualOverride: false })
    ).toBeUndefined()
    expect(
      reconcileTerminalManualMaskOverride({ autoDetectedPrompt: false, manualOverride: true })
    ).toBe(true)
    expect(
      resolveTerminalInputMaskedState({ autoDetectedPrompt: false, manualOverride: true })
    ).toBe(true)
  })
})
