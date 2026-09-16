import { describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { recordAgentSessionProviderHandle } from './agent-session-provider-handle-transition'

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
