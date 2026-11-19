import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import { ConversationTurnActivity } from './external-conversation-turn-activity'

const PANE = 'tab:1'
function harness() {
  const told: (string | undefined)[] = []
  const plans: unknown[] = []
  let plan: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] = []
  let row: Partial<AgentStatusIpcPayload> | null = null
  let turnId: number | null = 5
  const activity = new ConversationTurnActivity({
    emit: (event) => {
      told.push(event.text)
      plans.push(event.steps)
    },
    turnPlan: async () => ({ tasks: plan }),
    readHookRow: () => row as AgentStatusIpcPayload | null,
    toldTurn: () => turnId,
    linkedFor: () =>
      ({
        link: { source: 'slack', externalId: 'T1:C1:1.0', paneKey: PANE },
        workspace: { worktreeId: 'wt' }
      }) as never
  })
  const tool = (toolName: string, toolInput: string, state = 'working') => {
    row = { state, toolName, toolInput } as Partial<AgentStatusIpcPayload>
    activity.observe(PANE)
  }
  return {
    activity,
    told,
    plans,
    tool,
    turn: (id: number | null) => (turnId = id),
    writes: (tasks: typeof plan) => (plan = tasks)
  }
}

describe('ConversationTurnActivity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('tells the first tool at once, then a burst as its last, once the gap has passed', () => {
    const { told, tool } = harness()
    tool('Bash', 'pnpm test')
    tool('Read', 'a.ts')
    tool('Read', 'b.ts')
    expect(told).toEqual(['Running pnpm test'])
    vi.advanceTimersByTime(3_000)
    expect(told).toEqual(['Running pnpm test', 'Reading b.ts'])
    // Unchanged, it is not told again.
    tool('Read', 'b.ts')
    vi.advanceTimersByTime(10_000)
    expect(told).toHaveLength(2)
  })

  it('tells nothing of a turn its conversation doesn’t hear, or an agent not at work', () => {
    const { told, tool, turn } = harness()
    tool('Bash', 'ls', 'waiting')
    turn(null)
    tool('Bash', 'ls')
    expect(told).toEqual([])
  })

  it('starts the next turn fresh, and an ended turn’s waiting word never goes', () => {
    const { told, tool, turn } = harness()
    tool('Bash', 'one')
    tool('Bash', 'two')
    turn(null)
    vi.advanceTimersByTime(10_000)
    expect(told).toEqual(['Running one'])
    turn(6)
    tool('Bash', 'one')
    expect(told).toEqual(['Running one', 'Running one'])
  })

  it('reads the plan when the agent writes it, and tells it with every word after', async () => {
    const { told, plans, tool, writes } = harness()
    writes([
      { content: 'Read the code', status: 'completed' },
      { content: 'Fix it', status: 'in_progress' }
    ])
    tool('TodoWrite', '[{"content":"Read the code"')
    await vi.advanceTimersByTimeAsync(3_000)
    tool('Bash', 'pnpm test')
    await vi.advanceTimersByTimeAsync(3_000)
    const steps = [
      { title: 'Read the code', status: 'completed' },
      { title: 'Fix it', status: 'in_progress' }
    ]
    expect(told).toEqual(['Updating the plan', 'Updating the plan', 'Running pnpm test'])
    expect(plans).toEqual([undefined, steps, steps])
  })
})
