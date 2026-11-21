import { expect, it } from 'vitest'
import { join } from 'node:path'
import { createBotTurnContext } from './bot-turn-context'
import { HELD_BOT_RULES, TAKEN } from './bot-turn-rules.test-fixture'
import { ClaudePromptRegistry } from '../claude/structured/permissions/claude-prompt-registry'
import { buildClaudePromptReply } from '../claude/structured/journal/claude-structured-prompt-replies'
import { CodexPromptRegistry } from '../codex/structured/prompts/codex-prompt-registry'
import {
  prepareCodexPromptAnswer,
  applyCodexPromptAnswer
} from '../codex/structured/prompts/codex-structured-prompt-replies'

it.each([true, false])(
  'delivers memory on a mail turn and acknowledges only after handoff (launch delivered: %s)',
  async (delivered) => {
    const folder = join('bots', 'scout')
    let memory = '- Keep the fade'
    const fs = {
      readText: async (path: string) => (path.endsWith('MEMORY.md') ? memory : ''),
      replaceText: async () => false,
      writeText: async () => false
    }
    const turns = createBotTurnContext(fs)
    turns.launched('chat', 'bot', folder, { soul: '', memory }, delivered, HELD_BOT_RULES)
    memory = '- Remove the fade'
    const first = await turns.launchUpdate?.('chat')
    expect(first?.text).toContain('Remove the fade')
    expect((await turns.launchUpdate?.('chat'))?.text).toContain('Remove the fade')
    first?.given(TAKEN)
    expect(await turns.launchUpdate?.('chat')).toBeNull()
  }
)

it('relays the selected option meaning to Codex', () => {
  const prompt = new CodexPromptRegistry().register({
    id: 1,
    method: 'item/tool/requestUserInput',
    params: {
      itemId: 'tool',
      threadId: 'thread',
      turnId: 'turn',
      questions: [
        {
          id: 'when',
          question: 'When?',
          options: [{ label: 'Today', description: 'Keep the current version until tomorrow.' }]
        }
      ]
    }
  })
  if (!prompt) {
    throw new Error('Prompt registration failed')
  }
  const prepared = prepareCodexPromptAnswer(prompt, {
    kind: 'answers',
    answers: [{ questionId: 'when', optionIds: ['when:Today'] }]
  })
  expect(applyCodexPromptAnswer(prompt, prepared)).toEqual({
    answers: { when: { answers: ['Today — Keep the current version until tomorrow.'] } }
  })
})

it('refreshes report memory without admitting chat-history context and keeps that context pending for a typed turn', async () => {
  const folder = join('bots', 'scout')
  let memory = '- Keep the fade'
  const fs = {
    readText: async (path: string) => (path.endsWith('MEMORY.md') ? memory : ''),
    replaceText: async () => false,
    writeText: async () => false
  }
  const turns = createBotTurnContext(
    fs,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => ({ key: 'other-request', text: 'A different request discussed a release delay.' })
  )
  turns.launched('chat', 'bot', folder, { soul: '', memory }, true, HELD_BOT_RULES)
  memory = '- Remove the fade'
  const report = await turns.launchUpdate?.('chat')
  expect(report?.text).toContain('Remove the fade')
  expect(report?.text).not.toContain('A different request discussed a release delay.')
  report?.given(TAKEN)
  const typed = await turns.plan('chat', { kind: 'message', role: 'user', blocks: [] })
  expect(typed?.text).toContain('A different request discussed a release delay.')
  expect(typed?.text).not.toContain('Remove the fade')
})

it('relays the selected option meaning to Claude', () => {
  const registry = new ClaudePromptRegistry()
  const prompt = registry.register({
    requestId: 'ask',
    toolUseId: 'tool',
    toolName: 'AskUserQuestion',
    suggestions: [],
    settle: () => {},
    input: {
      questions: [
        {
          question: 'When?',
          options: [{ label: 'Today', description: 'Keep the current version until tomorrow.' }]
        }
      ]
    }
  })
  if (!prompt) {
    throw new Error('Prompt registration failed')
  }
  const reply = buildClaudePromptReply(prompt, {
    kind: 'answers',
    answers: [{ questionId: 'q1', optionIds: ['q1:choice-1'] }]
  })
  expect(reply).toMatchObject({
    updatedInput: { answers: { 'When?': 'Today — Keep the current version until tomorrow.' } }
  })
})

it('bounds description relay for the Claude legacy-label formatter without claiming those IDs pass current admission', () => {
  const prompt = new ClaudePromptRegistry().register({
    requestId: 'legacy',
    toolUseId: 'tool',
    toolName: 'AskUserQuestion',
    suggestions: [],
    settle: () => {},
    input: {
      questions: [
        { question: 'When?', options: [{ label: 'Today', description: '界'.repeat(1024) }] }
      ]
    }
  })
  if (!prompt) {
    throw new Error('Prompt registration failed')
  }
  const reply = buildClaudePromptReply(prompt, {
    kind: 'answers',
    answers: [{ questionId: 'q1', optionIds: ['When%3F:Today'] }]
  })
  if (
    reply.behavior !== 'allow' ||
    typeof reply.updatedInput?.answers !== 'object' ||
    reply.updatedInput.answers === null
  ) {
    throw new Error('Expected a question reply')
  }
  if (!('When?' in reply.updatedInput.answers)) {
    throw new Error('Expected the original question')
  }
  const text: unknown = reply.updatedInput.answers['When?']
  if (typeof text !== 'string') {
    throw new Error('Expected selected words')
  }
  expect(text).toContain('Today — 界')
  expect(text).toContain('[cut; review the original question]')
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024)
})

it('preserves owner free text verbatim in both provider replies', () => {
  const claude = new ClaudePromptRegistry().register({
    requestId: 'ask',
    toolUseId: 'tool',
    toolName: 'AskUserQuestion',
    suggestions: [],
    settle: () => {},
    input: { questions: [{ question: 'Notes?', options: [] }] }
  })
  if (!claude) {
    throw new Error('Prompt registration failed')
  }
  expect(
    buildClaudePromptReply(claude, {
      kind: 'answers',
      answers: [{ questionId: 'q1', optionIds: [], other: '  Keep this line.\n' }]
    })
  ).toMatchObject({ updatedInput: { answers: { 'Notes?': '  Keep this line.\n' } } })
  const codex = new CodexPromptRegistry().register({
    id: 1,
    method: 'item/tool/requestUserInput',
    params: { itemId: 'tool', threadId: 'thread', questions: [{ id: 'notes', question: 'Notes?' }] }
  })
  if (!codex) {
    throw new Error('Prompt registration failed')
  }
  expect(
    applyCodexPromptAnswer(
      codex,
      prepareCodexPromptAnswer(codex, {
        kind: 'answers',
        answers: [{ questionId: 'notes', optionIds: [], other: '  Keep this line.\n' }]
      })
    )
  ).toEqual({ answers: { notes: { answers: ['  Keep this line.\n'] } } })
})

it('marks an oversized Unicode selection explicitly and keeps the provider relay within 1 KiB', () => {
  const prompt = new CodexPromptRegistry().register({
    id: 1,
    method: 'item/tool/requestUserInput',
    params: {
      itemId: 'tool',
      threadId: 'thread',
      questions: [
        {
          id: 'notes',
          question: 'Which?',
          options: [{ label: 'Keep', description: '界'.repeat(1024) }]
        }
      ]
    }
  })
  if (!prompt) {
    throw new Error('Prompt registration failed')
  }
  const prepared = prepareCodexPromptAnswer(prompt, {
    kind: 'answers',
    answers: [{ questionId: 'notes', optionIds: ['notes:Keep'] }]
  })
  if (prepared.kind !== 'answer') {
    throw new Error('Expected a question answer')
  }
  expect(Buffer.byteLength(prepared.answer)).toBeLessThanOrEqual(1024)
  expect(prepared.answer).toContain('[cut; review the original question]')
  expect(prepared.answer).not.toContain('\uFFFD')
})
