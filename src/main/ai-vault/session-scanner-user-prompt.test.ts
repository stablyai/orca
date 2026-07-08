import { describe, expect, it } from 'vitest'
import { USER_PROMPT_TEXT_LIMIT, extractClaudeUserPromptText } from './session-scanner-user-prompt'

function userRecord(content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'user', message: { content }, ...extra }
}

describe('extractClaudeUserPromptText', () => {
  it('returns the text of a plain typed prompt (string content)', () => {
    expect(extractClaudeUserPromptText(userRecord('apruebo lo del wortree'))).toBe(
      'apruebo lo del wortree'
    )
  })

  it('returns the joined text of an array content prompt', () => {
    expect(
      extractClaudeUserPromptText(userRecord([{ type: 'text', text: 'como va el worflow?' }]))
    ).toBe('como va el worflow?')
  })

  it('keeps the text and drops image/tool_use blocks in a mixed prompt', () => {
    expect(
      extractClaudeUserPromptText(
        userRecord([
          { type: 'image', source: {} },
          { type: 'text', text: 'revisa este archivo' }
        ])
      )
    ).toBe('revisa este archivo')
  })

  it('excludes tool_result records (Claude stores them as type:user)', () => {
    expect(
      extractClaudeUserPromptText(
        userRecord([{ type: 'tool_result', tool_use_id: 'abc', content: 'file contents…' }])
      )
    ).toBeNull()
  })

  it('excludes injected context (isMeta), subagent turns (isSidechain) and compaction summaries', () => {
    expect(extractClaudeUserPromptText(userRecord('injected', { isMeta: true }))).toBeNull()
    expect(extractClaudeUserPromptText(userRecord('subagent turn', { isSidechain: true }))).toBeNull()
    expect(
      extractClaudeUserPromptText(userRecord('This session is being continued…', { isCompactSummary: true }))
    ).toBeNull()
  })

  it('excludes interrupt notices (structural id and text marker)', () => {
    expect(
      extractClaudeUserPromptText(
        userRecord([{ type: 'text', text: '[Request interrupted by user]' }], {
          interruptedMessageId: 'm1'
        })
      )
    ).toBeNull()
    expect(
      extractClaudeUserPromptText(userRecord('[Request interrupted by user for tool use]'))
    ).toBeNull()
  })

  it('excludes machine-injected orchestration / handoff / teammate messages', () => {
    expect(
      extractClaudeUserPromptText(userRecord('--- Orchestration Messages (1) --- From: TERM_X'))
    ).toBeNull()
    expect(
      extractClaudeUserPromptText(userRecord('Tienes un mensaje de handoff (priority high) en cola'))
    ).toBeNull()
    expect(
      extractClaudeUserPromptText(userRecord('Another Claude session sent a message: hola'))
    ).toBeNull()
    expect(
      extractClaudeUserPromptText(userRecord('<teammate-message teammate_id="x">hi</teammate-message>'))
    ).toBeNull()
  })

  it('excludes the Orca orchestration dispatch preamble injected into worker terminals', () => {
    const preamble =
      'You are working inside Orca, a multi-agent IDE. You are a dispatched worker.\nYour coordinator\'s terminal handle is: term_abc\n=== TASK ===\ndo the thing'
    expect(extractClaudeUserPromptText(userRecord(preamble))).toBeNull()
  })

  it('strips wrapper blocks but keeps the surrounding typed text', () => {
    const text = 'ejecuta esto <system-reminder>hidden ctx</system-reminder> ahora'
    expect(extractClaudeUserPromptText(userRecord(text))).toBe('ejecuta esto  ahora')
  })

  it('drops slash-command plumbing wrappers entirely when nothing is left', () => {
    const text = '<command-name>/model</command-name><command-message>model</command-message>'
    expect(extractClaudeUserPromptText(userRecord(text))).toBeNull()
  })

  it('suppresses injected AGENTS.md / <INSTRUCTIONS> context prefixes', () => {
    expect(
      extractClaudeUserPromptText(userRecord('# AGENTS.md instructions\nfollow these'))
    ).toBeNull()
    expect(extractClaudeUserPromptText(userRecord('<INSTRUCTIONS>do x</INSTRUCTIONS>'))).toBeNull()
  })

  it('returns null for non-user records and empty content', () => {
    expect(extractClaudeUserPromptText({ type: 'assistant', message: { content: 'hi' } })).toBeNull()
    expect(extractClaudeUserPromptText(userRecord('   '))).toBeNull()
    expect(extractClaudeUserPromptText(userRecord([]))).toBeNull()
  })

  it('caps very long prompts at the text limit', () => {
    const long = 'a'.repeat(USER_PROMPT_TEXT_LIMIT + 500)
    const result = extractClaudeUserPromptText(userRecord(long))
    expect(result).not.toBeNull()
    expect(result?.length).toBe(USER_PROMPT_TEXT_LIMIT)
  })
})
