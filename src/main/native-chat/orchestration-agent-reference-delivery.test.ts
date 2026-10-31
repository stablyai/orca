import { expect, it, vi } from 'vitest'
import { claudeDispatchMessageContent } from '../claude/claude-structured-dispatch-content'
import { turnInputFor } from '../codex/codex-structured-message-options'
import type { CodexTurnHost } from '../codex/codex-structured-turn-start'
import { createCodexDispatchEchoes } from '../codex/codex-structured-dispatch-echo'
import { preparePiRpcPrompt } from '../pi/rpc-prompt'
import { structuredAgentSessionSendBody } from '../../shared/structured-agent-session-send-mutation'
import { agentReferenceDeliveryText } from '../../shared/orchestration-agent-reference.test-fixture'

it('preserves the renderer-captured occurrence and address association through actual provider adapters', async () => {
  const body = structuredAgentSessionSendBody(agentReferenceDeliveryText, [])
  const codexHost: CodexTurnHost = {
    connection: { request: vi.fn<CodexTurnHost['connection']['request']>() },
    threadId: 'captured-thread',
    options: new Map(),
    dispatchEchoes: createCodexDispatchEchoes(),
    turnOpenWaits: { wait: vi.fn<CodexTurnHost['turnOpenWaits']['wait']>() }
  }
  expect(await claudeDispatchMessageContent(body)).toEqual([
    { type: 'text', text: agentReferenceDeliveryText }
  ])
  expect(turnInputFor(codexHost, body)).toEqual([
    { type: 'text', text: agentReferenceDeliveryText }
  ])
  expect((await preparePiRpcPrompt(body)).message).toBe(agentReferenceDeliveryText)
})
