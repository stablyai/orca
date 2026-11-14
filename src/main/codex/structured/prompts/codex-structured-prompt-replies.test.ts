import { describe, expect, it } from 'vitest'
import type { AgentSessionPromptResponse } from '../../../../shared/agent-session/agent-session-question-answer'
import { applyCodexPromptAnswer, prepareCodexPromptAnswer } from './codex-structured-prompt-replies'
import { CodexPromptRegistry, type CodexPendingPrompt } from './codex-prompt-registry'
import { MAX_CODEX_PROMPT_REGISTRY_ENTRIES } from './codex-prompt-registry-bounds'

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

describe('CodexPromptRegistry', () => {
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
  it('refuses an answer that names no question of a multi-question request', () => {
    const registry = new CodexPromptRegistry()
    const many = registry.register(userInputRequest(['q1', 'q2']))

    expect(() => answer(many, picked('sure'))).toThrow('does not name a question')
    expect(() => answer(many, typed('q3', 'sure'))).toThrow('does not name a question')
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
})

function mcpElicitationRequest(id: number, params: Record<string, unknown>) {
  return {
    id,
    method: 'mcpServer/elicitation/request',
    params: { threadId: 'thread-1', turnId: 'turn-1', serverName: 'codex_apps', ...params }
  }
}

const MCP_TOOL_APPROVAL = {
  mode: 'form',
  message: 'Allow Notion to run tool "notion.notion-update-page"?',
  requestedSchema: { type: 'object', properties: {} },
  _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] }
}

describe('MCP tool-call approvals', () => {
  it('refuses session reuse and Deny when the request did not offer them', () => {
    const registry = new CodexPromptRegistry()
    const prompt = registered(
      registry.register(
        mcpElicitationRequest(15, {
          ...MCP_TOOL_APPROVAL,
          _meta: { codex_approval_kind: 'mcp_tool_call' }
        })
      )
    )

    expect(() =>
      prepareCodexPromptAnswer(prompt, { kind: 'option', optionId: 'acceptForSession' })
    ).toThrow('did not offer acceptForSession')
    expect(() => prepareCodexPromptAnswer(prompt, { kind: 'option', optionId: 'decline' })).toThrow(
      'did not offer decline'
    )
  })
})
