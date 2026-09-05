import { describe, expect, it } from 'vitest'
import {
  buildAgentPromptFragment,
  detectAgentPromptComposerVerdict
} from './agent-prompt-composer-pending'

const PROMPT = [
  'You are working on task task_123 for dispatch ctx_456.',
  '',
  'Send worker_done when finished.'
].join('\n')

describe('detectAgentPromptComposerVerdict', () => {
  it('is unknown when no rendered screen exists', () => {
    expect(detectAgentPromptComposerVerdict(null, PROMPT)).toBe('unknown')
    expect(detectAgentPromptComposerVerdict({ lines: [] }, PROMPT)).toBe('unknown')
  })

  it('is pending when the emulator extracted a draft holding the payload', () => {
    expect(
      detectAgentPromptComposerVerdict(
        { lines: ['›'], draft: '[Pasted Content 5033 chars]' },
        PROMPT
      )
    ).toBe('pending')
    expect(
      detectAgentPromptComposerVerdict(
        { lines: ['›'], draft: 'You are working on task task_123 for dispatch ctx_456.' },
        PROMPT
      )
    ).toBe('pending')
  })

  it('is clear when the extracted draft is something else entirely', () => {
    expect(
      detectAgentPromptComposerVerdict({ lines: ['›'], draft: 'notes the operator typed' }, PROMPT)
    ).toBe('clear')
  })

  it('is pending for a Codex pasted-content placeholder on the prompt line', () => {
    const lines = [
      ' >_ OpenAI Codex (v0.152.0)',
      ' model:       gpt-5.6-sol medium',
      '› [Pasted Content 5033 chars]',
      '  tab to queue message',
      ' gpt-5.6-sol · 100% context left'
    ]
    expect(detectAgentPromptComposerVerdict({ lines }, PROMPT)).toBe('pending')
  })

  it.each([
    '❯ [Pasted text #1 +91 lines]',
    '❯ [Pasted: 91 lines]',
    '> [[ You are working.. [91 lines] .. ]]'
  ])('is pending for the placeholder %s', (composerLine) => {
    expect(detectAgentPromptComposerVerdict({ lines: ['history', composerLine] }, PROMPT)).toBe(
      'pending'
    )
  })

  it('is pending when the prompt text itself sits after the prompt glyph', () => {
    const lines = ['› You are working on task task_123 for dispatch ctx_456.', 'Send worker_done']
    expect(detectAgentPromptComposerVerdict({ lines }, PROMPT)).toBe('pending')
  })

  it('is clear when the last prompt line is empty even if history echoes the prompt', () => {
    const lines = [
      '> [Pasted text #1 +2 lines]',
      '✻ Thinking…',
      '────────',
      '❯',
      '────────',
      '? for shortcuts'
    ]
    expect(detectAgentPromptComposerVerdict({ lines }, PROMPT)).toBe('clear')
  })

  it('is clear when the prompt line holds unrelated text', () => {
    expect(
      detectAgentPromptComposerVerdict({ lines: ['› something the operator typed'] }, PROMPT)
    ).toBe('clear')
  })

  it('is unknown when no prompt glyph line exists on screen', () => {
    expect(detectAgentPromptComposerVerdict({ lines: ['plain output', 'more'] }, PROMPT)).toBe(
      'unknown'
    )
  })

  it('ignores a prompt glyph line that scrolled far above the bottom of the screen', () => {
    const lines = [
      '› [Pasted Content 5033 chars]',
      ...Array.from({ length: 20 }, (_, i) => `l${i}`)
    ]
    expect(detectAgentPromptComposerVerdict({ lines }, PROMPT)).toBe('unknown')
  })

  it('does not mistake the Codex banner for a composer line', () => {
    expect(
      detectAgentPromptComposerVerdict(
        { lines: [' >_ OpenAI Codex (v0.152.0)', 'model: gpt'] },
        PROMPT
      )
    ).toBe('unknown')
  })

  it('does not treat a shell prompt ending in > as a composer', () => {
    expect(detectAgentPromptComposerVerdict({ lines: ['PS C:\\repo> codex'] }, PROMPT)).toBe(
      'unknown'
    )
  })
})

describe('buildAgentPromptFragment', () => {
  it('uses the first non-empty line, collapsed and capped', () => {
    expect(buildAgentPromptFragment('\n\n  You   are working\ton task\nrest')).toBe(
      'You are working on task'
    )
    expect(buildAgentPromptFragment('x'.repeat(100))?.length).toBe(48)
  })

  it('refuses fragments too short to be distinctive', () => {
    expect(buildAgentPromptFragment('ok')).toBeNull()
    expect(buildAgentPromptFragment('   \n\n')).toBeNull()
  })
})
