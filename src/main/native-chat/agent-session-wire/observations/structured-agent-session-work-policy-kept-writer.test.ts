import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { StructuredAgentSessionWorkPolicy } from './structured-agent-session-work-policy'

// The last run's turn started at fence 4; this run reattached its writer and holds fence 6.
const turn = { itemId: 'turn-1', body: { kind: 'turn' } } as unknown as AgentJournalRenderItem
const facts = {
  item: () => turn,
  itemFence: () => 4,
  wroteBeforeOpen: () => true,
  runningTurn: () => ({ item: turn, turnId: 't1' }),
  recoverableSubmissions: () => [],
  continuingInput: () => false,
  finalizingInput: () => false,
  handingOver: () => false
}

describe('structured agent session work policy with a kept writer', () => {
  it('a reattached writer keeps the last run’s turn current instead of died', () => {
    const kept = new StructuredAgentSessionWorkPolicy(facts, 6, 0, undefined, {
      fence: 5,
      kept: true
    })
    expect(kept.activeTurnId()).toBe('t1')
    expect(kept.working()).toBe(true)
    expect(kept.diedTurn()).toBeNull()

    // Without the kept writer the same journal reads as a turn the replaced run took with it.
    const replaced = new StructuredAgentSessionWorkPolicy(facts, 6, 0, undefined, { fence: 5 })
    expect(replaced.activeTurnId()).toBeNull()
    expect(replaced.diedTurn()?.turnId).toBe('t1')
  })
})
