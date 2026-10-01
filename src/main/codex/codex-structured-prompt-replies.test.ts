import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_ID_MAX_LENGTH } from '../../shared/agent-session-wire'
import type { AgentSessionPromptResponse } from '../../shared/agent-session-question-answer'
import {
  applyCodexPromptAnswer,
  CodexPromptRegistry,
  prepareCodexPromptAnswer,
  type CodexPendingPrompt,
  MAX_CODEX_PROMPT_REGISTRY_BYTES,
  MAX_CODEX_PROMPT_REGISTRY_ENTRIES,
  codexJournalPromptIdPart,
  decodeCodexQuestionOptionId,
  encodeCodexJournalQuestionOptionId,
  encodeCodexQuestionOptionId
} from './codex-structured-prompt-replies'

function picked(optionId: string): AgentSessionPromptResponse {
  return { kind: 'answers', answers: [{ questionId: 'q1', optionIds: [optionId] }] }
}

function typed(questionId: string, other: string): AgentSessionPromptResponse {
  return { kind: 'answers', answers: [{ questionId, optionIds: [], other }] }
}

function registered(prompt: CodexPendingPrompt | null): CodexPendingPrompt {
  if (!prompt) {
    throw new Error('expected the request to register')
  }
  return prompt
}

function answer(
  prompt: CodexPendingPrompt | null,
  response: AgentSessionPromptResponse
): Record<string, unknown> | null {
  const live = registered(prompt)
  return applyCodexPromptAnswer(live, prepareCodexPromptAnswer(live, response))
}

function userInputRequest(questionIds: string[]): {
  id: number
  method: string
  params: unknown
} {
  return {
    id: 5,
    method: 'item/tool/requestUserInput',
    params: {
      itemId: 'codex-item-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      questions: questionIds.map((id) => ({ id }))
    }
  }
}

describe('codex question option ids', () => {
  it('round-trips a question id that itself contains the separator', () => {
    const optionId = encodeCodexQuestionOptionId('scope:write', 'yes / no')

    expect(decodeCodexQuestionOptionId(optionId)).toEqual({
      questionId: 'scope:write',
      answer: 'yes / no'
    })
  })

  it('reads nothing from an id with no separator', () => {
    expect(decodeCodexQuestionOptionId('accept')).toBeNull()
  })

  it('bounds journal option ids while preserving the exact Codex answer', () => {
    const longQuestionId = 'q'.repeat(5_000)
    const longAnswer = 'answer '.repeat(5_000)
    const optionId = encodeCodexJournalQuestionOptionId(longQuestionId, longAnswer)
    const registry = new CodexPromptRegistry()
    const prompt = registry.register({
      id: 9,
      method: 'item/tool/requestUserInput',
      params: {
        itemId: 'codex-item-1',
        threadId: 'thread-1',
        questions: [{ id: longQuestionId, options: [{ label: longAnswer }] }]
      }
    })

    expect(Buffer.byteLength(optionId, 'utf8')).toBeLessThan(1024)
    expect(codexJournalPromptIdPart(longQuestionId)).not.toBe(longQuestionId)
    expect(answer(prompt, picked(optionId))).toEqual({
      answers: { [longQuestionId]: { answers: [longAnswer] } }
    })
  })
})

describe('CodexPromptRegistry', () => {
  it('ignores a request that names no item or thread', () => {
    const registry = new CodexPromptRegistry()

    expect(
      registry.register({ id: 1, method: 'item/tool/requestUserInput', params: { itemId: 'i1' } })
    ).toBeNull()
    expect(registry.register({ id: 2, method: 'account/refresh', params: {} })).toBeNull()
  })

  it('keeps two prompts that share one tool item apart', () => {
    const registry = new CodexPromptRegistry()
    const ask = (id: number, approvalId: string): void => {
      registry.register({
        id,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'codex-item-1', approvalId, threadId: 'thread-1' }
      })
    }

    ask(1, 'approval-a')
    ask(2, 'approval-b')

    // The second ask must not have replaced the first, or the turn blocks on a
    // request nobody can address any more.
    expect(registry.find('approval-a')?.requestId).toBe(1)
    expect(registry.find('approval-b')?.requestId).toBe(2)
    // Nothing addresses the shared item id, because it names two live prompts.
    expect(registry.find('codex-item-1')).toBeNull()
  })

  it('clears only prompts belonging to a settled turn', () => {
    const registry = new CodexPromptRegistry()
    registry.register({
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'root-item', threadId: 'thread-1' }
    })
    registry.register({
      id: 2,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'other-item', threadId: 'thread-1', turnId: 'turn-2' }
    })
    registry.register({
      id: 3,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'other-thread-item', threadId: 'thread-2', turnId: 'turn-1' }
    })
    registry.bindJournalItemId('journal-root', 'thread-1', 'root-item', 'turn-1')

    registry.clearTurn('thread-1', 'turn-1')

    expect(registry.find('root-item')).toBeNull()
    expect(registry.find('journal-root')).toBeNull()
    expect(registry.find('other-item')?.requestId).toBe(2)
    expect(registry.find('other-thread-item')?.requestId).toBe(3)
  })

  it('retains a bounded cleanup identity for an unaddressable backfilled turn id', () => {
    const registry = new CodexPromptRegistry()
    const turnId = 'turn-'.padEnd(MAX_CODEX_PROMPT_REGISTRY_BYTES + 1, 'x')
    registry.register({
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'root-item', threadId: 'thread-1' }
    })

    registry.bindJournalItemId('journal-root', 'thread-1', 'root-item', turnId)

    expect(registry.bytes).toBeLessThanOrEqual(MAX_CODEX_PROMPT_REGISTRY_BYTES)
    registry.clearTurn('thread-1', turnId)
    expect(registry.find('journal-root')).toBeNull()
  })

  it('reserves enough bytes for a wire-valid multibyte backfilled turn id', () => {
    const registry = new CodexPromptRegistry()
    registry.register({
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'root-item', threadId: 'thread-1' }
    })
    const reservedBytes = registry.bytes
    const turnId = '界'.repeat(AGENT_SESSION_ID_MAX_LENGTH)

    registry.bindJournalItemId('journal-root', 'thread-1', 'root-item', turnId)

    expect(registry.find('journal-root')?.turnId).toBe(turnId)
    expect(registry.bytes).toBe(reservedBytes)
    expect(registry.bytes).toBeLessThanOrEqual(MAX_CODEX_PROMPT_REGISTRY_BYTES)
  })

  it('rejects a request turn id beyond the wire identity bound', () => {
    const registry = new CodexPromptRegistry()
    const turnId = 'x'.repeat(AGENT_SESSION_ID_MAX_LENGTH + 1)
    const prompt = registry.register({
      id: 1,
      method: 'item/commandExecution/requestApproval',
      params: { itemId: 'root-item', threadId: 'thread-1', turnId }
    })

    expect(prompt).toBeNull()
    expect(registry.bytes).toBe(0)
  })

  it('addresses a prompt by its journal item id once bound, and forgets both', () => {
    const registry = new CodexPromptRegistry()
    const prompt = registry.register(userInputRequest(['q1']))
    registry.bindJournalItemId('codex:thread-1:turn-1:2', 'thread-1', 'codex-item-1')

    expect(registry.find('codex:thread-1:turn-1:2')).toBe(prompt)
    expect(registry.find('codex-item-1')).toBe(prompt)

    registry.forget(prompt as NonNullable<typeof prompt>)
    expect(registry.find('codex:thread-1:turn-1:2')).toBeNull()
    expect(registry.find('codex-item-1')).toBeNull()
  })

  it('keeps identical item ids on different threads independently answerable', () => {
    const registry = new CodexPromptRegistry()
    const register = (id: number, threadId: string) =>
      registry.register({
        id,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: 'item-2', threadId }
      })

    register(1, 'thread-root')
    register(2, 'thread-child')
    registry.bindJournalItemId('journal-root', 'thread-root', 'item-2')
    registry.bindJournalItemId('journal-child', 'thread-child', 'item-2')

    expect(registry.find('journal-root')?.requestId).toBe(1)
    expect(registry.find('journal-child')?.requestId).toBe(2)
    expect(registry.find('item-2')).toBeNull()
  })

  it('keeps a journal-bound pending prompt answerable after the lookup window evicts it', () => {
    const registry = new CodexPromptRegistry()
    const first = registry.register(userInputRequest(['q1']))
    registry.bindJournalItemId('journal-first', 'thread-1', 'codex-item-1')

    for (let index = 0; index <= MAX_CODEX_PROMPT_REGISTRY_ENTRIES; index += 1) {
      registry.register({
        id: index + 10,
        method: 'item/commandExecution/requestApproval',
        params: { itemId: `item-${index}`, threadId: 'thread-1' }
      })
    }

    expect(registry.find('journal-first')).toBe(first)
  })
})

describe('applyCodexPromptAnswer', () => {
  it('answers the lone question of a single-question request with typed text', () => {
    const registry = new CodexPromptRegistry()
    const single = registry.register(userInputRequest(['q1']))

    expect(answer(single, typed('q1', 'sure'))).toEqual({
      answers: { q1: { answers: ['sure'] } }
    })
  })

  it('refuses an answer that names no question of a multi-question request', () => {
    const registry = new CodexPromptRegistry()
    const many = registry.register(userInputRequest(['q1', 'q2']))

    expect(() => answer(many, picked('sure'))).toThrow('does not name a question')
    expect(() => answer(many, typed('q3', 'sure'))).toThrow('does not name a question')
  })

  it('keeps the last answer when a question is answered twice', () => {
    const registry = new CodexPromptRegistry()
    const single = registry.register(userInputRequest(['q1']))

    answer(single, typed('q1', 'first'))

    expect(answer(single, typed('q1', 'second'))).toEqual({
      answers: { q1: { answers: ['second'] } }
    })
  })

  it('refuses an answer over the registry bound before recording anything', () => {
    const registry = new CodexPromptRegistry()
    const single = registry.register(userInputRequest(['q1']))
    const live = registered(single)

    expect(() => prepareCodexPromptAnswer(live, typed('q1', 'x'.repeat(64 * 1024 + 1)))).toThrow(
      'exceeds bounded registry state'
    )
    expect(live.answers.size).toBe(0)
  })

  it('refuses question and option collections that exceed bounded live state', () => {
    const registry = new CodexPromptRegistry()
    const tooManyQuestions = registry.register(
      userInputRequest(Array.from({ length: 65 }, (_, index) => `q${index}`))
    )
    expect(tooManyQuestions).toBeNull()

    const hugeOptionRequest = {
      id: 10,
      method: 'item/tool/requestUserInput',
      params: {
        itemId: 'item-huge-options',
        threadId: 'thread-1',
        questions: [
          { id: 'q1', options: Array.from({ length: 257 }, (_, i) => ({ label: `option-${i}` })) }
        ]
      }
    }
    expect(registry.register(hugeOptionRequest)).toBeNull()

    const hugeQuestionId = 'x'.repeat(32 * 1024 + 1)
    expect(registry.register(userInputRequest([hugeQuestionId]))).toBeNull()
  })
})
