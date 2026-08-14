import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import { scopeStructuredSessionTranscript } from './structured-agent-session-transcript-scope'

const link = (threadId: string): AgentSessionProviderHandleLink => ({
  linkId: threadId,
  handle: { provider: 'codex', threadId },
  origin: 'created',
  mintedAtFence: 1,
  observedAt: 0
})
const message = (threadId: string): AgentJournalItemIdentity => ({
  provider: 'codex',
  threadId,
  turnId: 'turn',
  ordinal: 0
})
const row = (identity: AgentJournalItemIdentity): AgentJournalRenderItem => ({
  itemId: agentJournalItemKey(identity),
  revision: 1,
  sequence: 1,
  observedAt: 0,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'same text' }] }
})

it('scopes speech and tools by durable identity, preserving coordination and actionable prompts', () => {
  const parent = row(message('parent'))
  const previous = row(message('previous'))
  const child = row(message('child'))
  const parentTool = row({ provider: 'orca', clientMessageId: 'codex-item:parent:tool' })
  const childTool = row({ provider: 'orca', clientMessageId: 'codex-item:child:tool' })
  parentTool.body = childTool.body = {
    kind: 'tool-call',
    name: 'spawn_agent',
    state: 'completed',
    input: {}
  }
  const prompt: AgentJournalRenderItem = {
    ...child,
    body: {
      kind: 'approval',
      title: 'Allow child?',
      detail: null,
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
  }
  const diagnostic: AgentJournalRenderItem = { ...child, body: { kind: 'status', text: 'Warning' } }
  const items = [parent, previous, child, parentTool, childTool, prompt, diagnostic]
  expect(
    scopeStructuredSessionTranscript(items, {
      providerHandleChain: [link('previous'), link('parent')]
    })
  ).toEqual([parent, previous, parentTool, prompt, diagnostic])
  expect(scopeStructuredSessionTranscript(items, { providerHandleChain: [link('child')] })).toEqual(
    [child, childTool, prompt, diagnostic]
  )
  expect(scopeStructuredSessionTranscript(items, null)).toBe(items)
  expect(scopeStructuredSessionTranscript(items, { providerHandleChain: [] })).toBe(items)
  expect(
    scopeStructuredSessionTranscript(
      [row({ provider: 'claude', sessionId: 'claude', uuid: 'message' })],
      { providerHandleChain: [link('parent')] }
    )
  ).toHaveLength(1)
})
