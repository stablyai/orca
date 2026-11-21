import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusState } from '../../shared/agent-status/contracts/agent-status-types'
import { ConversationTurnActivity } from './external-conversation-turn-activity'

const PANE = 'tab:1'
function harness() {
  const told: (string | undefined)[] = []
  const plans: unknown[] = []
  let plan: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] = []
  // Reads a test answers by hand, in the order they are asked for.
  const planReads: (() => Promise<{ tasks: typeof plan } | null>)[] = []
  let row: { state: AgentStatusState; toolName: string; toolInput: string } | null = null
  let turnId: number | null = 5
  const activity = new ConversationTurnActivity({
    emit: (event) => {
      told.push(event.text)
      plans.push(event.steps)
    },
    turnPlan: () => (planReads.shift() ?? (async () => ({ tasks: plan })))(),
    readHookRow: () => row,
    toldTurn: () => turnId,
    linkedFor: () => ({
      link: { source: 'slack', externalId: 'T1:C1:1.0', paneKey: PANE, sessionId: 's1' },
      workspace: { worktreeId: 'wt' }
    })
  })
  const tool = (toolName: string, toolInput: string, state: AgentStatusState = 'working') => {
    row = { state, toolName, toolInput }
    activity.observe(PANE)
  }
  return {
    activity,
    told,
    plans,
    tool,
    turn: (id: number | null) => (turnId = id),
    writes: (tasks: typeof plan) => (plan = tasks),
    planReads
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

  it('leaves a plan step that looks like it holds a secret out of what the thread is told', async () => {
    const { plans, tool, writes } = harness()
    writes([
      { content: 'Set API_KEY=sk-ant-abcdefgh12345678 in .env', status: 'in_progress' },
      { content: 'Open https://x.dev/cb?token=abc123def456', status: 'pending' },
      { content: 'Run the tests', status: 'pending' }
    ])
    tool('TodoWrite', 'plan')
    await vi.advanceTimersByTimeAsync(3_000)

    expect(plans.at(-1)).toEqual([
      { title: 'Step left out: it looked like it held a secret', status: 'in_progress' },
      { title: 'Open https://x.dev/cb?…', status: 'pending' },
      { title: 'Run the tests', status: 'pending' }
    ])
  })

  it('reports the plan with activity until the agent clears it', async () => {
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

    writes([])
    tool('TodoWrite', 'none')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(plans.at(-1)).toBeUndefined()
    tool('Bash', 'ls')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(told.at(-1)).toBe('Running ls')
    expect(plans.at(-1)).toBeUndefined()
  })

  it('keeps the newer plan when an older read answers last', async () => {
    const { plans, tool, planReads } = harness()
    const answers: ((content: string) => void)[] = []
    const held = () =>
      new Promise<{ tasks: { content: string; status: 'pending' }[] }>((resolve) =>
        answers.push((content) => resolve({ tasks: [{ content, status: 'pending' }] }))
      )
    planReads.push(held, held)
    tool('TodoWrite', 'first')
    tool('Bash', 'ls')
    tool('TodoWrite', 'second')
    answers[1]?.('newer')
    await vi.advanceTimersByTimeAsync(3_000)
    answers[0]?.('older')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(plans.at(-1)).toEqual([{ title: 'newer', status: 'pending' }])
  })

  it('drops a plan read begun before the teller was cleared, when it answers after a newer one', async () => {
    const { activity, plans, tool, planReads } = harness()
    const answers: ((content: string) => void)[] = []
    const held = () =>
      new Promise<{ tasks: { content: string; status: 'pending' }[] }>((resolve) =>
        answers.push((content) => resolve({ tasks: [{ content, status: 'pending' }] }))
      )
    planReads.push(held, held)
    tool('TodoWrite', 'first')
    activity.clear()
    tool('TodoWrite', 'second')
    answers[1]?.('newer')
    await vi.advanceTimersByTimeAsync(3_000)
    answers[0]?.('older')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(plans.at(-1)).toEqual([{ title: 'newer', status: 'pending' }])
  })
})
