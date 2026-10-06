// A restart continuation that no agent took is the message's own failure, said on the message: the
// restart list files nothing and the chat gets no note, whatever kept it from an agent.

import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { handedOverContinuationOutcome } from './structured-agent-session-continuation-verdict'

function rejectedWith(kind: 'providerStartFailed' | 'hostFault' | 'providerRejected') {
  return {
    dispatchState: 'rejected',
    handoverRecorded: true as const,
    ...agentSessionFailureWords(agentSessionFailureFact(kind), {
      surface: 'rejection',
      agentName: 'Codex'
    })
  }
}

describe('a restart continuation settled before its turn', () => {
  it.each(['providerStartFailed', 'hostFault'] as const)(
    'is its own failed start when no agent took it (%s)',
    (kind) => {
      expect(handedOverContinuationOutcome('s1', rejectedWith(kind))).toMatchObject({
        outcome: 'refused',
        startFailed: true
      })
    }
  )

  it('is filed when an agent took it and Orca failed after', () => {
    expect(
      handedOverContinuationOutcome('s1', { ...rejectedWith('hostFault'), handedOverAt: 5 })
    ).not.toHaveProperty('startFailed')
  })

  it('is filed when the provider refused it', () => {
    expect(
      handedOverContinuationOutcome('s1', rejectedWith('providerRejected'))
    ).not.toHaveProperty('startFailed')
  })
})
