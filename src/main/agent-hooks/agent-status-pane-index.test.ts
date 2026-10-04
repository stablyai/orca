import { expect, it } from 'vitest'
import {
  indexAgentStatusRowsByPaneKey,
  indexPaneKeysByProviderSessionId
} from './agent-status-pane-index'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'

function row(paneKey: string, sessionId?: string): AgentStatusIpcPayload {
  return {
    paneKey,
    state: 'working',
    prompt: '',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    ...(sessionId ? { providerSession: { key: 'session_id', id: sessionId } } : {})
  }
}

it('maps each provider session to the pane its agent runs in', () => {
  const indexed = indexPaneKeysByProviderSessionId([
    row('tab-a:leaf-1', 'claude-one'),
    row('tab-a:leaf-2', 'claude-two'),
    row('tab-b:leaf-1', 'codex-one')
  ])
  expect(indexed.get('claude-one')).toBe('tab-a:leaf-1')
  expect(indexed.get('claude-two')).toBe('tab-a:leaf-2')
  expect(indexed.get('codex-one')).toBe('tab-b:leaf-1')
  expect(indexed.size).toBe(3)
})

it('drops a session two panes claim rather than picking one', () => {
  const indexed = indexPaneKeysByProviderSessionId([
    row('tab-a:leaf-1', 'claude-one'),
    row('tab-b:leaf-1', 'claude-one')
  ])
  expect(indexed.has('claude-one')).toBe(false)
})

it('keeps a repeated row for one pane, and drops rows naming only half the pair', () => {
  const indexed = indexPaneKeysByProviderSessionId([
    row('tab-a:leaf-1', 'claude-one'),
    row('tab-a:leaf-1', 'claude-one'),
    row('tab-b:leaf-1'),
    row('', 'claude-two')
  ])
  expect(indexed.get('claude-one')).toBe('tab-a:leaf-1')
  expect(indexed.has('claude-two')).toBe(false)
  expect(indexed.size).toBe(1)
})

it('still groups the same snapshot by pane key', () => {
  const byPane = indexAgentStatusRowsByPaneKey([
    row('tab-a:leaf-1', 'claude-one'),
    row('tab-a:leaf-1', 'claude-two'),
    row('', 'claude-three')
  ])
  expect(byPane.get('tab-a:leaf-1')).toHaveLength(2)
  expect(byPane.size).toBe(1)
})
