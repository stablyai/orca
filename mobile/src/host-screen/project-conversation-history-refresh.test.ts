import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import { conversationHistory } from './project-conversations.test-fixture'
import { refreshProjectConversationHistory } from './project-conversation-history-refresh'

it.each(['missing prior snapshot', 'mismatched fingerprint'] as const)(
  'recovers a full snapshot instead of clearing the list for an unverifiable unchanged reply: %s',
  async (reason) => {
    let scans = 0
    const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) => ({
      id: 'host',
      ok: true,
      result:
        method === 'status.get'
          ? { capabilities: ['aiVault.v1'] }
          : ++scans === 1
            ? { sessions: [], issues: [], unchanged: true, fingerprint: 'other' }
            : {
                sessions: [conversationHistory()],
                issues: [],
                fingerprint: 'fresh',
                includesStructuredSessions: true
              }
    }))
    const client = { ...new FakeSession('connected'), sendRequest }
    const previous =
      reason === 'missing prior snapshot'
        ? undefined
        : {
            sessions: [conversationHistory()],
            issues: [],
            fingerprint: 'old',
            includesStructuredSessions: true as const
          }
    const result = await refreshProjectConversationHistory(client, false, previous)
    expect(result.history?.sessions).toHaveLength(1)
    expect(result.history?.fingerprint).toBe('fresh')
    const requests = sendRequest.mock.calls.filter(([method]) => method === 'aiVault.listSessions')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.[1]).not.toHaveProperty('afterFingerprint')
  }
)

it('reports a host that never supplies the requested full history instead of accepting an empty unchanged reply', async () => {
  const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method) => ({
    id: 'host',
    ok: true,
    result:
      method === 'status.get'
        ? { capabilities: ['aiVault.v1'] }
        : { sessions: [], issues: [], unchanged: true, fingerprint: 'unknown' }
  }))
  const client = { ...new FakeSession('connected'), sendRequest }
  await expect(refreshProjectConversationHistory(client, false)).rejects.toThrow('full snapshot')
})
