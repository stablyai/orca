import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { structuredAgentSessionEndedChildFailure } from './structured-agent-session-delivery-loop'
import type {
  StructuredAgentSessionChildEndCause,
  StructuredAgentSessionEndedChild
} from './structured-agent-session-host-types'

const EXIT_FAILURE = agentSessionFailureFact('providerExited', {
  detail: { text: 'crashed', audience: 'log' }
})

function ended(
  cause: StructuredAgentSessionChildEndCause,
  duringStartup: boolean
): StructuredAgentSessionEndedChild {
  return {
    generation: 'generation-1',
    fence: 2,
    rootGone: true,
    cause,
    reason: null,
    failure: EXIT_FAILURE,
    duringStartup,
    endedAt: { epoch: 'epoch-1', sequence: 3 }
  }
}

describe('what a child end means for the messages queued behind it', () => {
  it.each([false, true])("fails nothing after a user's Stop (during startup: %s)", (starting) => {
    expect(structuredAgentSessionEndedChildFailure(ended('user-stop', starting))).toBeNull()
  })

  it.each([false, true])(
    'is a start Orca stopped after a host stop (during startup: %s)',
    (starting) => {
      expect(structuredAgentSessionEndedChildFailure(ended('host-stop', starting))).toEqual({
        failure: { kind: 'hostStopped' }
      })
    }
  )

  it.each(['exit', 'attach-failed', 'evict'] as const)(
    'carries the recorded failure of a %s, as a failed start while starting',
    (cause) => {
      expect(structuredAgentSessionEndedChildFailure(ended(cause, true))).toEqual({
        exit: EXIT_FAILURE
      })
      expect(structuredAgentSessionEndedChildFailure(ended(cause, false))).toEqual({
        failure: EXIT_FAILURE
      })
      expect(
        structuredAgentSessionEndedChildFailure({ ...ended(cause, false), failure: undefined })
      ).toEqual({ failure: agentSessionFailureFact('providerExited') })
    }
  )
})
