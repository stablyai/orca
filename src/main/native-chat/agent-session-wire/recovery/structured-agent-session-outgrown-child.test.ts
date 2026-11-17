import { expect, it } from 'vitest'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import { readStructuredAgentSessionAccountTransition } from './structured-agent-session-outgrown-child'

const NOW = 1_800_000_000_000
const A = { variable: 'CLAUDE_CONFIG_DIR', path: '/homes/a' }
const B = { variable: 'CLAUDE_CONFIG_DIR', path: '/homes/b' }

/** A ready agent on A whose last turn ended at `ended`; a start would now use B. */
function transition(childWork: AgentChildWorkView[], ended = NOW - 10 * 60_000) {
  return readStructuredAgentSessionAccountTransition(
    {
      child: { phase: 'ready', fence: 2, accountHome: A },
      journal: {
        reads: {
          outgrownChild: async () => ({
            signedOut: false,
            newestTurnCompletedAt: ended,
            nextMessage: null
          })
        }
      }
    },
    {
      work: {
        currentWork: async () => ({
          kind: 'child-work',
          working: false,
          activeTurn: false,
          actionablePrompt: false,
          newestTurnCompletedAt: ended
        }),
        childWork: () => childWork,
        childWorkOpen: () => false,
        hasOpenDispatch: () => false,
        providerHoldsDispatch: () => false
      },
      launchAccountHome: async () => B,
      now: () => NOW
    }
  )
}

function settled(at: number, outcome: AgentChildWorkView['outcome']): AgentChildWorkView {
  const view: AgentChildWorkView = {
    id: 'task',
    kind: 'agent',
    state: 'done',
    membership: 'settled',
    firstObservedAt: at - 1_000,
    observedAt: at,
    settledAt: at,
    outcome,
    stoppable: false,
    invocation: { invocationId: 'spawn', generation: 1 }
  }
  return view
}

it('waits for the lead to answer work that just finished, until two minutes after it ended', async () => {
  expect(await transition([settled(NOW - 30_000, 'succeeded')])).toEqual({
    cause: 'account',
    waitsFor: 'wake-up',
    wakeUpUntil: NOW - 30_000 + 120_000,
    from: A,
    to: B
  })
  expect(await transition([settled(NOW - 3 * 60_000, 'succeeded')])).toBeNull()
})

it('never waits for a wake-up after a stopped task', async () => {
  expect(await transition([settled(NOW - 5_000, 'cancelled')])).toBeNull()
})
