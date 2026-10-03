import { describe, expect, it } from 'vitest'
import {
  computeAgentAcknowledgementTargets,
  type AgentAttentionTurnRecords
} from './agent-attention-acknowledgement'

const KEY = 'tab-1:leaf-1'

describe('computeAgentAcknowledgementTargets', () => {
  // The row has read `working` since 1_000 while a subagent runs; its main agent was cut at 3_000.
  // An acknowledgement from before the cut must not keep an on-screen chat from clearing it.
  const heldOpen = {
    stateStartedAt: 1_000,
    mainAgent: { stateStartedAt: 3_000 }
  }

  it("acknowledges a viewed chat whose main agent was cut after the user's last look", () => {
    const live: Omit<AgentAttentionTurnRecords, 'acknowledgedTurnStartedAt'> = {
      liveTurns: { [KEY]: heldOpen },
      retainedTurns: {}
    }
    const retained: Omit<AgentAttentionTurnRecords, 'acknowledgedTurnStartedAt'> = {
      liveTurns: {},
      retainedTurns: { [KEY]: { entry: heldOpen } }
    }
    for (const records of [live, retained]) {
      expect(
        computeAgentAcknowledgementTargets(
          { ...records, acknowledgedTurnStartedAt: { [KEY]: 2_000 } },
          KEY
        )
      ).toEqual([KEY])
      expect(
        computeAgentAcknowledgementTargets(
          { ...records, acknowledgedTurnStartedAt: { [KEY]: 3_000 } },
          KEY
        )
      ).toEqual([])
    }
  })
})
