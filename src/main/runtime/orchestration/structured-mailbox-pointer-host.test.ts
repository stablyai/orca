import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { createStructuredMailboxPointerHost, readStructuredSessionGateFacts } =
  await import('./structured-mailbox-pointer-host')

function runningTurn(): AgentJournalRenderItem {
  return {
    itemId: 'lifecycle-1',
    revision: 1,
    body: { kind: 'status', text: 'working', turnLifecycle: { turnId: 'turn-1', state: 'running' } }
  } as unknown as AgentJournalRenderItem
}

function transcript(count: number): AgentJournalRenderItem[] {
  return Array.from(
    { length: count },
    (_unused, index) =>
      ({
        itemId: `tool-${index}`,
        revision: 1,
        body: { kind: 'tool-call', name: 'Bash', input: {}, state: 'completed' }
      }) as unknown as AgentJournalRenderItem
  )
}

describe('structured mailbox pointer host', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('reads the gate facts from the FULL timeline, never a bounded tail', async () => {
    // Read the full timeline: a busy turn's lifecycle item may be far from the tail, and false idle can interrupt it.
    const items = [runningTurn(), ...transcript(500)]
    hostRef.current = {
      journalSnapshot: () => ({ items, submissions: [] }),
      currentWork: () => null
    }
    expect(await readStructuredSessionGateFacts('s1')).toEqual({
      turnRunning: true,
      awaitingHuman: false
    })
  })

  it('reads exact ordinary creation at its original authority across route/card/provider changes and refuses invalid callers', () => {
    const record = agentSessionConversationView(agentSessionRecordFixture())
    let receipt: unknown = {
      operationId: 'op1',
      sessionId: record.sessionId,
      callerKey: 'trusted-local:orchestration:ordinary-mail',
      method: 'agentSession.send',
      status: 'accepted',
      result: { kind: 'queued-draft', messageId: 'op1' }
    }
    const read = vi.fn(() => ({ verdict: 'readable', receipt }))
    hostRef.current = {
      deps: {
        store: {
          readCommandReceipt: read,
          getConversation: (id: string) => (id === record.sessionId ? record : null),
          listConversations: () => [record],
          getVisibleSessionTabIndex: () => ({ present: false, sessionIds: [] })
        }
      }
    }
    const host = createStructuredMailboxPointerHost()
    expect(host.readCreation('op1', record.sessionId)).toBe('accepted')
    expect(read).toHaveBeenCalledWith({ kind: 'global' }, 'op1')
    expect(host.readCreation('op1', 'unrelated')).toBe('accepted')
    receipt = {
      status: 'accepted',
      method: 'agentSession.send',
      sessionId: record.sessionId,
      callerKey: 'other-client',
      result: { kind: 'queued-draft', messageId: 'op1' }
    }
    expect(host.readCreation('op1', record.sessionId)).toBe('unknown')
    hostRef.current = { deps: { store: { readCommandReceipt: () => ({ verdict: 'unreadable' }) } } }
    expect(host.readCreation('op1', record.sessionId)).toBe('unknown')
    hostRef.current = null
    expect(host.readCreation('op1', record.sessionId)).toBe('unknown')
  })
})
