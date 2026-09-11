// The main-process half of the credential-prompt corpus: every screen the shared detector
// blocks must also reach `agent-credential-prompt` through the wait-blocked vocabulary, which
// is what makes `writeTerminalAgentPrompt` refuse the PTY write.
import { describe, expect, it } from 'vitest'
import {
  LEGITIMATE_AGENT_SCREENS,
  LIVE_CREDENTIAL_SURFACES
} from '../../shared/terminal-credential-prompt-corpus'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptPreview
} from './terminal-wait-detection'

function screen(lines: string[]): string {
  return lines.join('\n')
}

describe('credential prompts reach the wait-blocked vocabulary', () => {
  it.each(LIVE_CREDENTIAL_SURFACES)('reports agent-credential-prompt for %s', (_name, lines) => {
    expect(detectTerminalWaitBlockedReason(screen(lines))).toBe('agent-credential-prompt')
  })

  it.each(LEGITIMATE_AGENT_SCREENS)(
    'does not report a credential prompt for %s',
    (_name, lines) => {
      expect(detectTerminalWaitBlockedReason(screen(lines))).not.toBe('agent-credential-prompt')
    }
  )

  it('ignores an answered credential prompt that scrolled out of the live window', () => {
    const tail = screen([
      'Enter your API key:',
      '',
      'Signed in as neil@example.com.',
      '',
      'OpenAI Codex',
      'model: gpt-6',
      'directory: ~/repo',
      '',
      '› Ask Codex to do anything'
    ])
    expect(detectTerminalWaitBlockedReason(tail)).toBeNull()
  })

  it('refuses to call the #19749 screen a ready prompt', () => {
    // HEAD's Antigravity readiness rule (header, a gemini model row, a lone `>` caret) is all
    // present here, which is exactly why the detector reported ready while the dialog was live.
    const tail = screen([
      'Antigravity CLI',
      'gemini 3 pro (high)',
      '>',
      '',
      '  Sign in to Antigravity',
      '  Open https://antigravity.google/device and enter the code: KXTD-9PQR',
      '  Waiting for authentication…'
    ])
    expect(isKnownReadyPromptPreview(tail)).toBe(false)
    expect(detectTerminalWaitBlockedReason(tail)).toBe('agent-credential-prompt')
  })

  it('is not cleared by a ready caret drawn elsewhere on the screen', () => {
    // Every other blocked reason is dismissible by a live prompt; this one must not be, or the
    // agent's own input box would vouch for the dialog covering it.
    const tail = screen([
      'OpenAI Codex',
      'model: gpt-6',
      'directory: ~/repo',
      '› Ask Codex to do anything',
      '',
      'Authentication required',
      'Sign in with GitHub to continue'
    ])
    expect(detectTerminalWaitBlockedReason(tail)).toBe('agent-credential-prompt')
  })
})
