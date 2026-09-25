import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { isAgentSessionRecord } from '../../shared/agent-session-record'
import {
  recordAgentSessionProviderHandle,
  reviseAgentSessionClaudeResumePoint
} from './agent-session-provider-handle-transition'

function resumedLink(fence: number): AgentSessionProviderHandleLink {
  return {
    linkId: 'link-2',
    handle: { provider: 'claude', sessionId: 'provider-session-alpha-1', leafUuid: 'leaf-2' },
    origin: 'resumed',
    mintedAtFence: fence,
    observedAt: 4_000
  }
}

describe('recordAgentSessionProviderHandle', () => {
  it('advances a live Claude chain head and its proof', () => {
    const record = agentSessionRecordFixture()
    const next = recordAgentSessionProviderHandle({
      record,
      fence: record.lease.runtimeFence,
      link: resumedLink(record.lease.runtimeFence),
      now: 4_000
    })
    expect(next.providerHandleChain.at(-1)?.handle).toMatchObject({ leafUuid: 'leaf-2' })
    expect(next.lease.provenHandleLinkId).toBe('link-2')
  })

  it('records a leaf during proof without granting ownership', () => {
    const lease = agentSessionLeaseFixture({
      runtimeFence: 8,
      claimStatus: 'reserved',
      handoffStage: 'new-owner-proving',
      provenHandleLinkId: null
    })
    const next = recordAgentSessionProviderHandle({
      record: agentSessionRecordFixture(lease),
      fence: lease.runtimeFence,
      link: resumedLink(lease.runtimeFence),
      now: 4_000
    })
    expect(next.providerHandleChain.at(-1)?.handle).toMatchObject({ leafUuid: 'leaf-2' })
    expect(next.lease).toMatchObject({ claimStatus: 'reserved', provenHandleLinkId: null })
  })
})

describe('reviseAgentSessionClaudeResumePoint', () => {
  const revise = (record = agentSessionRecordFixture(), leafUuid = 'leaf-2') =>
    reviseAgentSessionClaudeResumePoint({
      record,
      fence: record.lease.runtimeFence,
      providerSessionId: 'provider-session-alpha-1',
      leafUuid,
      now: 5_000
    })

  it('moves the head leaf in place, turn after turn, without growing the chain', () => {
    const record = agentSessionRecordFixture()
    const second = revise(revise(record, 'leaf-2'), 'leaf-3')
    expect(second.providerHandleChain).toHaveLength(record.providerHandleChain.length)
    expect(second.providerHandleChain.at(-1)).toMatchObject({
      linkId: 'link-1',
      origin: 'created',
      handle: { leafUuid: 'leaf-3' }
    })
    expect(second.lease.provenHandleLinkId).toBe('link-1')
    expect(isAgentSessionRecord(second)).toBe(true)
  })

  it('refuses a stale owner, a released lease, and a head minted by another owner', () => {
    const record = agentSessionRecordFixture()
    expect(() =>
      reviseAgentSessionClaudeResumePoint({
        record,
        fence: record.lease.runtimeFence - 1,
        providerSessionId: 'provider-session-alpha-1',
        leafUuid: 'leaf-2',
        now: 5_000
      })
    ).toThrow('agent_session_stale_fence')
    expect(() =>
      revise(agentSessionRecordFixture(agentSessionLeaseFixture({ claimStatus: 'released' })))
    ).toThrow('agent_session_ownership_unknown')
    const later = agentSessionRecordFixture(agentSessionLeaseFixture({ runtimeFence: 9 }))
    expect(() =>
      revise({
        ...later,
        providerHandleChain: [{ ...later.providerHandleChain[0]!, mintedAtFence: 7 }]
      })
    ).toThrow('agent_session_provider_handle_invalid')
    expect(() =>
      reviseAgentSessionClaudeResumePoint({
        record,
        fence: record.lease.runtimeFence,
        providerSessionId: 'another-provider-session',
        leafUuid: 'leaf-2',
        now: 5_000
      })
    ).toThrow('agent_session_provider_handle_invalid')
  })
})
