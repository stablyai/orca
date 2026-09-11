// Which conversation a structured chat tab is published as. The head of the handle chain is the
// one the session writes to now; an earlier link names a conversation it has moved on from.

import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import { headStructuredProviderSessionId } from '../native-chat/agent-session-wire/structured-provider-session-ownership'
import {
  refreshStructuredProviderSessions,
  withStructuredProviderSessionId
} from './structured-agent-session-provider-session-publication'

function chatTab(providerSessionId?: string): RuntimeMobileSessionTabsSnapshot['tabs'][number] {
  return {
    type: 'agent-session',
    id: 'agent-session:session-1',
    title: 'Claude Chat',
    sessionId: 'session-1',
    agent: 'claude',
    ...(providerSessionId ? { providerSessionId } : {}),
    isActive: false
  } as RuntimeMobileSessionTabsSnapshot['tabs'][number]
}

function forkedTo(sessionId: string): AgentSessionRecord {
  const record = agentSessionRecordFixture()
  return {
    ...record,
    providerHandleChain: [
      ...record.providerHandleChain,
      {
        linkId: 'link-2',
        origin: 'forked',
        mintedAtFence: record.lease.runtimeFence,
        observedAt: 2_000,
        forkedFromKey: 'link-1',
        handle: { provider: 'claude', sessionId, leafUuid: null }
      }
    ]
  }
}

describe('structured chat provider session publication', () => {
  it('reads the conversation from the head of the chain', () => {
    expect(headStructuredProviderSessionId(agentSessionRecordFixture())).toBe(
      'provider-session-alpha-1'
    )
  })

  it('never presents a forked session as its origin', () => {
    expect(headStructuredProviderSessionId(forkedTo('provider-session-fork'))).toBe(
      'provider-session-fork'
    )
  })

  it('reports unknown identity rather than throwing on a record with no chain', () => {
    const chainless = { ...agentSessionRecordFixture(), providerHandleChain: [] }
    expect(headStructuredProviderSessionId(chainless)).toBeNull()
    const malformed = { ...agentSessionRecordFixture() } as AgentSessionRecord
    delete (malformed as { providerHandleChain?: unknown }).providerHandleChain
    expect(headStructuredProviderSessionId(malformed)).toBeNull()
  })

  it('reads a Codex thread id as the conversation', () => {
    const record = agentSessionRecordFixture()
    const codex: AgentSessionRecord = {
      ...record,
      provider: 'codex',
      providerHandleChain: [
        { ...record.providerHandleChain[0]!, handle: { provider: 'codex', threadId: 'thread-9' } }
      ]
    }
    expect(headStructuredProviderSessionId(codex)).toBe('thread-9')
  })

  it('omits the field rather than publishing a blank conversation id', () => {
    const stamped = withStructuredProviderSessionId(chatTab('provider-1'), null)
    expect('providerSessionId' in stamped).toBe(false)
  })

  it('stamps a conversation proven after the tab was minted', () => {
    expect(withStructuredProviderSessionId(chatTab(), 'provider-1')).toMatchObject({
      providerSessionId: 'provider-1'
    })
  })

  it('returns the same array when no chat tab moved, so an idle pass cannot bump the snapshot', () => {
    const tabs = [chatTab('provider-1')]
    expect(refreshStructuredProviderSessions(tabs, () => 'provider-1')).toBe(tabs)
  })

  it('re-reads every chat tab when the conversation changed', () => {
    const tabs = [chatTab()]
    const refreshed = refreshStructuredProviderSessions(tabs, () => 'provider-2')
    expect(refreshed).not.toBe(tabs)
    expect(refreshed[0]).toMatchObject({ providerSessionId: 'provider-2' })
  })

  it('leaves tabs that are not structured chats alone', () => {
    const terminal = {
      type: 'terminal',
      id: 'tab-1'
    } as RuntimeMobileSessionTabsSnapshot['tabs'][number]
    const tabs = [terminal]
    expect(refreshStructuredProviderSessions(tabs, () => 'provider-1')).toBe(tabs)
  })
})
