import { expect, it } from 'vitest'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/resume/agent-session-resume-marker'
import { createStructuredAgentSessionRestartWitnesses } from './structured-agent-session-restart-witnesses'
import {
  marker,
  NOW,
  SESSION
} from './testing/structured-agent-session-restart-resume.test-fixture'

/** A chat whose journal says Orca's quit cut turn-9, with prompt `ask-2` in the cut turn. */
function cutOf(offers: AgentSessionResumeMarker[]) {
  const reads = {
    restartCut: async () => ({ promptItemIds: ['ask-1', 'ask-2'] }),
    orcaStopCut: async () => ({ turnItemId: 'turn-item-9', cause: 'quit' as const }),
    item: async () => ({ body: { kind: 'turn', turnId: 'turn-9', state: 'interrupted' } })
  }
  const witnesses = createStructuredAgentSessionRestartWitnesses({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: cutOf reads only these journal reads.
    sessions: new Map([[SESSION, { journal: { reads } }]]) as never,
    getRecord: () => null,
    childWork: () => undefined,
    childWorkOpen: () => false,
    capsule: {
      record: async () => {},
      passOverAutomatic: async () => {},
      list: async () => offers,
      listFailed: async () => []
    },
    teardownId: 'teardown',
    now: () => NOW,
    enqueue: (operation) => operation(),
    open: async () => ({ readable: true })
  })
  return witnesses.cutOf(SESSION)
}

it("reads a restart's cut from its offer, the prompt it asked from the journal, else the journal's stop row", async () => {
  expect(await cutOf([marker({ trigger: 'crash' })])).toEqual({ cause: 'crash', turnId: 'turn-1' })
  const asking = marker({
    activity: { state: 'blocked', prompts: [{ kind: 'question', label: 'Which?' }], tasks: [] }
  })
  expect(await cutOf([asking])).toEqual({
    cause: 'quit',
    turnId: 'turn-1',
    waitingOn: { promptItemId: 'ask-2' }
  })
  expect(await cutOf([])).toEqual({ cause: 'quit', turnId: 'turn-9' })
})
