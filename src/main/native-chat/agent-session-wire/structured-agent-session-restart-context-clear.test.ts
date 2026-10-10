import { describe, expect, it } from 'vitest'
import { structuredAgentSessionResumableSet } from './structured-agent-session-restart-resume-set'
import {
  structuredAgentSessionWorkingAtStop,
  structuredAgentSessionWorkInFlight
} from './structured-agent-session-working-at-teardown'
import {
  record,
  marker,
  journal,
  turnItem,
  submission,
  NOW,
  SESSION,
  TEARDOWN_CURRENT
} from './structured-agent-session-restart-resume-test-harness'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'

const boundary = { operationId: 'clear', afterFence: 1, clearedAt: NOW }
const clear: AgentJournalRenderItem = {
  itemId: 'clear',
  sequence: 5,
  revision: 1,
  observedAt: NOW,
  body: { kind: 'status', text: 'Context cleared', contextClear: boundary }
}
const value = (): ReturnType<typeof record> & { providerContextBoundary: typeof boundary } => ({
  ...record(),
  providerHandleChain: [],
  providerContextBoundary: boundary
})
const set = (m = marker(), r = value()) =>
  structuredAgentSessionResumableSet({
    markers: [m],
    getRecord: () => r,
    supportsRecord: () => true,
    latestPrompt: () => 'prior prompt',
    movedOn: () => false,
    savedByNewerOrca: () => false
  })

describe('restart offers after context clear', () => {
  it('retires the old-context offer before any new provider handle exists', () => {
    expect(set()).toEqual({ candidates: [], superseded: [marker()] })
    expect(set({ ...marker(), contextClearOperationId: 'previous-clear' })).toEqual({
      candidates: [],
      superseded: [{ ...marker(), contextClearOperationId: 'previous-clear' }]
    })
  })

  it('does not treat an old unknown send as new-context work during teardown', () => {
    const unknown = { ...submission('old-send', 'unknown'), acceptedSequence: 2 }
    expect(
      structuredAgentSessionWorkInFlight([turnItem('old', 'running'), clear], [unknown])
    ).toBeNull()
    expect(
      structuredAgentSessionWorkingAtStop({
        sessionId: SESSION,
        session: {
          journal: journal([turnItem('old', 'running'), clear], [unknown]),
          child: { fence: 2 }
        },
        getRecord: value,
        childWork: () => undefined,
        trigger: 'quit',
        teardownId: TEARDOWN_CURRENT,
        now: NOW
      })
    ).toBeNull()
  })

  it('stamps a current-context offer and keeps it eligible after restart', () => {
    const proved = { ...record().providerHandleChain[0], linkId: 'new', mintedAtFence: 2 }
    const currentRecord = {
      ...value(),
      providerHandleChain: [proved]
    }
    const turn = { ...turnItem('new-turn', 'running'), sequence: 6 }
    const offer = structuredAgentSessionWorkingAtStop({
      sessionId: SESSION,
      session: { journal: journal([clear, turn]), child: { fence: 2 } },
      getRecord: () => currentRecord,
      childWork: () => undefined,
      trigger: 'quit',
      teardownId: TEARDOWN_CURRENT,
      now: NOW
    })!
    expect(offer.contextClearOperationId).toBe('clear')
    expect(set(offer, currentRecord).candidates).toHaveLength(1)
  })
})
