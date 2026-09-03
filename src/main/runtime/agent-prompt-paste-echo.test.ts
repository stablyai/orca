import { describe, expect, it } from 'vitest'
import { buildAgentPromptPasteBytes } from '../../shared/agent-prompt-injection'
import {
  AGENT_PROMPT_ECHO_TIMEOUT_MS_DEFAULT,
  AGENT_PROMPT_ECHO_TIMEOUT_MS_WIN32,
  deriveAgentPromptPasteEchoProbe,
  getAgentPromptPasteEchoTimeoutMs,
  isAgentPromptPasteEchoObserved,
  isAgentPromptPasteEchoPlaceholderObserved
} from './agent-prompt-paste-echo'

describe('deriveAgentPromptPasteEchoProbe', () => {
  it('strips the bracketed-paste markers and whitespace, then takes the last 24 chars', () => {
    const prompt = `line one\nline two\n${'z'.repeat(40)}`
    const probe = deriveAgentPromptPasteEchoProbe(buildAgentPromptPasteBytes(prompt))
    expect(probe).toBe('z'.repeat(24))
  })

  it('collapses interior whitespace before taking the tail', () => {
    const prompt = 'a b c d e f g h i j k l m n o p q r s t u v w x y z'
    const probe = deriveAgentPromptPasteEchoProbe(buildAgentPromptPasteBytes(prompt))
    // Why: whitespace is removed entirely, not just trimmed, before the 24-char tail is taken.
    expect(probe).toBe(stripWhitespace(prompt).slice(-24))
  })

  it('returns null (skip echo wait) when the inner text has fewer than 8 non-whitespace chars', () => {
    const probe = deriveAgentPromptPasteEchoProbe(buildAgentPromptPasteBytes('short'))
    expect(probe).toBeNull()
  })

  it('keeps a prompt with exactly 8 non-whitespace chars', () => {
    const probe = deriveAgentPromptPasteEchoProbe(buildAgentPromptPasteBytes('12345678'))
    expect(probe).toBe('12345678')
  })
})

describe('isAgentPromptPasteEchoObserved', () => {
  const probe = deriveAgentPromptPasteEchoProbe(buildAgentPromptPasteBytes('y'.repeat(40)))!

  it('matches when the pane text contains the probe tail', () => {
    expect(isAgentPromptPasteEchoObserved(`composer> ${'y'.repeat(40)}`, probe)).toBe(true)
  })

  it('matches the probe even when the pane wraps it across whitespace/newlines', () => {
    const wrapped = `composer> ${'y'.repeat(20)}\n  ${'y'.repeat(20)}`
    expect(isAgentPromptPasteEchoObserved(wrapped, probe)).toBe(true)
  })

  it('does not match unrelated pane text', () => {
    expect(isAgentPromptPasteEchoObserved('composer is empty', probe)).toBe(false)
  })

  it('does not treat a prompt-supplied placeholder as a tail echo', () => {
    const prompt = `[Pasted text #1 +40 lines]\n${'z'.repeat(40)}`
    const promptProbe = deriveAgentPromptPasteEchoProbe(buildAgentPromptPasteBytes(prompt))!

    expect(isAgentPromptPasteEchoObserved('[Pasted text #1 +40 lines]', promptProbe)).toBe(false)
  })

  it('matches a collapsed-paste placeholder in output known to follow the write', () => {
    expect(isAgentPromptPasteEchoPlaceholderObserved('[Pasted text #1 +40 lines]')).toBe(true)
  })

  it('matches other collapsed-paste placeholder variants in post-write output', () => {
    expect(isAgentPromptPasteEchoPlaceholderObserved('[Pasted Content 40 lines]')).toBe(true)
    expect(isAgentPromptPasteEchoPlaceholderObserved('Pasted content added')).toBe(true)
  })
})

describe('getAgentPromptPasteEchoTimeoutMs', () => {
  it('uses the longer timeout on win32', () => {
    expect(getAgentPromptPasteEchoTimeoutMs('win32')).toBe(AGENT_PROMPT_ECHO_TIMEOUT_MS_WIN32)
  })

  it('uses the shorter timeout on other platforms', () => {
    expect(getAgentPromptPasteEchoTimeoutMs('darwin')).toBe(AGENT_PROMPT_ECHO_TIMEOUT_MS_DEFAULT)
    expect(getAgentPromptPasteEchoTimeoutMs('linux')).toBe(AGENT_PROMPT_ECHO_TIMEOUT_MS_DEFAULT)
  })
})

function stripWhitespace(text: string): string {
  return text.replace(/\s+/g, '')
}
