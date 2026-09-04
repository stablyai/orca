import { describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { replaceAgentSessionProvider } from './agent-session-provider-replacement'

const NOW = 1_800_000_000_000
const GROK_HOME = { variable: 'GROK_HOME' as const, path: '/home/dev/.grok' }

function replaceArgs(overrides: Partial<Parameters<typeof replaceAgentSessionProvider>[0]> = {}) {
  const record = overrides.record ?? agentSessionRecordFixture()
  return {
    record,
    expectedFence: record.lease.runtimeFence,
    provider: 'grok' as const,
    accountHome: GROK_HOME,
    spawnToken: 'spawn-grok',
    claimKeyId: 'key-1',
    handoffOperationId: 'op-switch-1',
    now: NOW,
    leaseTtlMs: 30_000,
    ...overrides
  }
}

describe('replaceAgentSessionProvider', () => {
  it('clears the handle chain, flips provider, and reserves the next fence', () => {
    const result = replaceAgentSessionProvider(replaceArgs({ model: 'grok-4.6' }))
    expect(result.disposition).toBe('replaced')
    expect(result.record).toMatchObject({
      provider: 'grok',
      accountHome: GROK_HOME,
      providerHandleChain: [],
      options: { model: 'grok-4.6' },
      lease: {
        runtimeFence: 8,
        claimStatus: 'reserved',
        handoffStage: 'new-owner-proving',
        ownerProcess: null,
        reservedSpawnToken: 'spawn-grok',
        provenHandleLinkId: null,
        handoffOperationId: 'op-switch-1',
        runtimeKind: 'native'
      }
    })
  })

  it('replays the same in-flight reservation instead of minting a second fence', () => {
    const first = replaceAgentSessionProvider(replaceArgs())
    const retry = replaceAgentSessionProvider(
      replaceArgs({
        record: first.record,
        expectedFence: first.record.lease.runtimeFence
      })
    )
    expect(retry).toEqual({ record: first.record, disposition: 'retry-reservation' })
  })

  it('refuses a live same-provider no-op so callers use setOption', () => {
    const record = agentSessionRecordFixture()
    expect(() =>
      replaceAgentSessionProvider(
        replaceArgs({
          record,
          provider: 'claude',
          accountHome: record.accountHome
        })
      )
    ).toThrow('agent_session_operation_invalid')
  })

  it('refuses a stale fence and a mid-handoff lease', () => {
    expect(() => replaceAgentSessionProvider(replaceArgs({ expectedFence: 1 }))).toThrow(
      'agent_session_checkpoint_stale'
    )
    const preparing = agentSessionRecordFixture()
    preparing.lease.handoffStage = 'preparing'
    expect(() => replaceAgentSessionProvider(replaceArgs({ record: preparing }))).toThrow(
      'agent_session_conflict'
    )
  })

  it('keeps non-model options when the replacement names a model', () => {
    const record = agentSessionRecordFixture()
    record.options = { model: 'opus', approvalPolicy: 'on-request', personality: 'pragmatic' }
    const result = replaceAgentSessionProvider(replaceArgs({ record, model: 'grok-4.6' }))
    expect(result.record.options).toEqual({
      model: 'grok-4.6',
      approvalPolicy: 'on-request',
      personality: 'pragmatic'
    })
  })

  it('keeps prior options when the replacement does not name a model', () => {
    const record = agentSessionRecordFixture()
    record.options = { approvalPolicy: 'on-request' }
    const result = replaceAgentSessionProvider(replaceArgs({ record }))
    expect(result.record.options).toEqual({ approvalPolicy: 'on-request' })
  })

  it('honours a recovery floor when minting the next fence', () => {
    const record = agentSessionRecordFixture()
    record.lease.minimumNextFence = 12
    const result = replaceAgentSessionProvider(replaceArgs({ record }))
    expect(result.record.lease.runtimeFence).toBe(12)
  })
})
