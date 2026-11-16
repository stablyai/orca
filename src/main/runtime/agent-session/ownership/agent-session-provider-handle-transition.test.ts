import { describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle'
import { isPersistedAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { encodeAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import { activeProviderContext } from '../../../../shared/agent-session/agent-session-provider-context'
import {
  recordAgentSessionProviderHandle,
  reviseAgentSessionProviderResumePoint
} from './agent-session-provider-handle-transition'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

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
})
