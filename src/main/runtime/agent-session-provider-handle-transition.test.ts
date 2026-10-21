import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { isPersistedAgentSessionRecord } from '../../shared/agent-session-record'
import { encodeAgentSessionRecord } from '../../shared/agent-session-record-stored-form'
import { activeProviderContext } from '../../shared/agent-session-provider-context'
import {
  recordAgentSessionProviderHandle,
  reviseAgentSessionProviderResumePoint
} from './agent-session-provider-handle-transition'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'

function resumedLink(fence: number): AgentSessionProviderHandleLink {
  return {
    linkId: 'link-2',
    handle: claudeProviderHandle('provider-session-alpha-1', 'leaf-2'),
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
    expect(next.providerHandleChain.at(-1)?.handle).toMatchObject({ resumeCursor: 'leaf-2' })
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
    expect(next.providerHandleChain.at(-1)?.handle).toMatchObject({ resumeCursor: 'leaf-2' })
    expect(next.lease).toMatchObject({ claimStatus: 'reserved', provenHandleLinkId: null })
  })

  it('rejects delayed old-child proof and records fresh creation behind the clear boundary', () => {
    const previous = agentSessionRecordFixture()
    const record = {
      ...previous,
      providerHandleChain: [],
      lease: { ...previous.lease, runtimeFence: 8 },
      providerContextBoundary: { operationId: 'clear', afterFence: 7, clearedAt: 4500 }
    }
    expect(() =>
      recordAgentSessionProviderHandle({
        record,
        fence: 7,
        link: resumedLink(7),
        now: 5000
      })
    ).toThrow('agent_session_stale_fence')
    expect(activeProviderContext(record).head).toBeNull()
    const fresh = recordAgentSessionProviderHandle({
      record,
      fence: 8,
      now: 5000,
      link: {
        linkId: 'fresh',
        origin: 'created',
        mintedAtFence: 8,
        observedAt: 5000,
        handle: claudeProviderHandle('fresh-context', null)
      }
    })
    expect(fresh.providerHandleChain).toHaveLength(1)
    expect(activeProviderContext(fresh).head).toMatchObject({
      linkId: 'fresh',
      origin: 'created'
    })
    expect(fresh.providerHandleChain[0]?.replaces).toBeUndefined()
  })
})

describe('reviseAgentSessionProviderResumePoint', () => {
  const revise = (record = agentSessionRecordFixture(), leafUuid = 'leaf-2') =>
    reviseAgentSessionProviderResumePoint({
      record,
      fence: record.lease.runtimeFence,
      handle: claudeProviderHandle('provider-session-alpha-1', leafUuid),
      now: 5_000
    })

  it('moves the head leaf in place, turn after turn, without growing the chain', () => {
    const record = agentSessionRecordFixture()
    const second = revise(revise(record, 'leaf-2'), 'leaf-3')
    expect(second.providerHandleChain).toHaveLength(record.providerHandleChain.length)
    expect(second.providerHandleChain.at(-1)).toMatchObject({
      linkId: 'link-1',
      origin: 'created',
      handle: { resumeCursor: 'leaf-3' }
    })
    expect(second.lease.provenHandleLinkId).toBe('link-1')
    expect(isPersistedAgentSessionRecord(encodeAgentSessionRecord(second))).toBe(true)
  })

  it('refuses a stale owner, a released lease, and a head minted by another owner', () => {
    const record = agentSessionRecordFixture()
    expect(() =>
      reviseAgentSessionProviderResumePoint({
        record,
        fence: record.lease.runtimeFence - 1,
        handle: claudeProviderHandle('provider-session-alpha-1', 'leaf-2'),
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
      reviseAgentSessionProviderResumePoint({
        record,
        fence: record.lease.runtimeFence,
        handle: claudeProviderHandle('another-provider-session', 'leaf-2'),
        now: 5_000
      })
    ).toThrow('agent_session_provider_handle_invalid')
    // Same id, another provider's namespace: a different conversation, never this one's leaf.
    expect(() =>
      reviseAgentSessionProviderResumePoint({
        record,
        fence: record.lease.runtimeFence,
        handle: codexProviderHandle('provider-session-alpha-1'),
        now: 5_000
      })
    ).toThrow('agent_session_provider_handle_invalid')
  })
})
