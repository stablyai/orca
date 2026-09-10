import { describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { claudeRewindAcquisitionProofs } from './structured-rewind-claude-proof'

function setup() {
  let current = agentSessionRecordFixture()
  current.providerHandleChain = current.providerHandleChain.map((link) => ({
    ...link,
    handle: { provider: 'claude', sessionId: 'provider-session-alpha-1', leafUuid: 'tip' }
  }))
  current.rewind = {
    operationId: 'rewind-operation',
    callerKey: 'desktop',
    itemId: 'selected',
    expectedEpoch: 'old-epoch',
    phase: 'prepared',
    retained: []
  }
  const store: Pick<AgentSessionRecordStore, 'transitionHandoff'> = {
    transitionHandoff: async (_sessionId, transition) => {
      current = transition(current)
      return current
    }
  }
  return {
    store,
    record: () => current,
    setFence: () => {
      current = { ...current, lease: { ...current.lease, runtimeFence: 8 } }
    }
  }
}

describe('Claude rewind durable proof checkpoints', () => {
  it('atomically checkpoints the exact target and resumable head before owner publication', async () => {
    const state = setup()
    const proofs = claudeRewindAcquisitionProofs({
      store: state.store,
      record: state.record(),
      now: () => 3_000,
      rewind: { previousLeafUuid: 'tip', targetUuid: 'kept' }
    })
    await expect(proofs.rewind!.onProved!('wrong')).rejects.toThrow('proof-mismatch')
    expect(state.record().rewind?.phase).toBe('prepared')
    expect(state.record().providerHandleChain.at(-1)?.handle).toMatchObject({ leafUuid: 'tip' })
    await proofs.rewind!.onProved!('kept')
    expect(state.record().rewind).toMatchObject({
      phase: 'provider-succeeded',
      hydrationVerified: true
    })
    expect(state.record().providerHandleChain.at(-1)?.handle).toMatchObject({ leafUuid: 'kept' })
    expect(
      claudeRewindAcquisitionProofs({
        store: state.store,
        record: state.record(),
        now: () => 3_001,
        rewind: undefined
      })
    ).toEqual({})
  })
  it('restores prepared recovery through ordinary proof without carrying rewind authorization', async () => {
    const state = setup()
    const proofs = claudeRewindAcquisitionProofs({
      store: state.store,
      record: state.record(),
      now: () => 3_000,
      rewind: undefined
    })
    expect(proofs.rewind).toBeUndefined()
    expect(proofs.rewindRecovery?.leafUuid).toBe('tip')
    expect(state.record().rewind?.phase).toBe('prepared')
    await proofs.rewindRecovery!.onProved()
    expect(state.record().rewind).toMatchObject({ phase: 'refused', retained: [] })
    expect(state.record().providerHandleChain.at(-1)?.handle).toMatchObject({ leafUuid: 'tip' })
  })
  it('refuses a proof checkpoint from a superseded acquisition', async () => {
    const state = setup()
    const proofs = claudeRewindAcquisitionProofs({
      store: state.store,
      record: state.record(),
      now: () => 3_000,
      rewind: { previousLeafUuid: 'tip', targetUuid: 'kept' }
    })
    state.setFence()
    await expect(proofs.rewind!.onProved!('kept')).rejects.toThrow('checkpoint_stale')
    expect(state.record().rewind?.phase).toBe('prepared')
    expect(state.record().providerHandleChain.at(-1)?.handle).toMatchObject({ leafUuid: 'tip' })
  })
})
