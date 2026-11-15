import { describe, expect, it } from 'vitest'
import {
  agentSessionFailureFact,
  readWholeAgentSessionFailureFact
} from '../../../../../shared/agent-session/failures/agent-session-failure'
import {
  AgentSessionAcquisitionExitProvenError,
  AgentSessionAcquisitionExitUnprovenError
} from '../../acquisition/structured-agent-session-acquisition-errors'
import { AgentSessionStartFailure } from '../../startup/structured-agent-session-start-failure'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data.test-fixture'
import {
  acquire,
  accept,
  advanceHostWallClock,
  eventually,
  heldBehindStart,
  host,
  proveOpen,
  publishFirst,
  restartWith,
  store,
  submission,
  registerStartupAttemptHostTests
} from './structured-agent-session-startup-attempt-host.test-fixture'

registerStartupAttemptHostTests()

describe('what a started child reports', () => {
  it('preserves a final provider answer through nested acquisition exit proofs', async () => {
    await restartWith(async () => {
      throw new AgentSessionAcquisitionExitProvenError(
        new AgentSessionAcquisitionExitProvenError(
          new AgentSessionStartFailure(new Error('the connection ended'), 'never', {
            kind: 'providerStartFailed',
            detail: { text: 'the provider declined startup', audience: 'person' }
          })
        )
      )
    })
    const id = await accept('preserve the final answer')
    await eventually(async () => {
      const sent = await submission(id)
      expect(sent?.dispatchState).toBe('rejected')
      expect(readWholeAgentSessionFailureFact(sent?.rejection)).toMatchObject({
        kind: 'providerStartFailed',
        detail: { text: 'the provider declined startup', audience: 'person' }
      })
    })
  })

  it('keeps an unproven owner refusal ahead of an embedded provider failure', async () => {
    await restartWith(async () => {
      throw new AgentSessionAcquisitionExitUnprovenError(
        new AgentSessionStartFailure(
          new Error('provider exited'),
          'safe',
          agentSessionFailureFact('providerStartFailed')
        )
      )
    })
    const id = await accept('preserve ownership')
    await eventually(async () => {
      const sent = await submission(id)
      expect(sent?.dispatchState).toBe('rejected')
      expect(readWholeAgentSessionFailureFact(sent?.rejection)).toMatchObject({
        kind: 'restartFailed',
        refusal: {
          code: 'agent_session_ownership_unknown',
          details: { reason: 'ownerUnproven' }
        }
      })
    })
  })

  it('preserves a later accepted pick when an older child reports options', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    await store.replaceSessionOptions({
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      options: { model: 'picked' },
      now: NOW
    })
    await proveOpen('reported')
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
    await host.handleAdapterEvent({
      type: 'options-reported',
      sessionId: SESSION,
      fence: store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
      reportedOptions: { model: 'from-settings' }
    })
    await host.flushStreamedEvents(SESSION)
    expect(store.getRecord(SESSION)?.options).toEqual({ model: 'picked' })
  })
})

describe('a start across a sleep', () => {
  it('lets a start that a sleep held past the idle window finish and deliver its message', async () => {
    await restartWith(publishFirst)
    const id = await heldBehindStart('hello')
    advanceHostWallClock(2 * 60 * 60_000)
    await host.collaboratorsForTests().lifetime.idleSweep.tick()
    await proveOpen()
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('accepted'))
  })
})
