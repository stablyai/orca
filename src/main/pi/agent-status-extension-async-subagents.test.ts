import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_STATUS_EXTENSION_SELF_PID,
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'

// Event shapes and orderings mirror traces recorded from pi-subagents 0.71.0.
const WORKFLOW = 'workflow-1'
const idle = { isIdle: () => true }

type PostedChild = { id: string; state: string; startedAt: number; agentType?: string }
type PostedPayload = { hook_event_name: string; subagents?: PostedChild[] }

function posts(harness: AgentStatusExtensionHarness): PostedPayload[] {
  return harness.fetchMock.mock.calls.map((call) => {
    const body: { payload: PostedPayload } = JSON.parse(String(call[1]?.body))
    return body.payload
  })
}

function postedHookNames(harness: AgentStatusExtensionHarness): string[] {
  return posts(harness).map((post) => post.hook_event_name)
}

function agentEndCount(harness: AgentStatusExtensionHarness): number {
  return postedHookNames(harness).filter((name) => name === 'agent_end').length
}

function startWorkflow(harness: AgentStatusExtensionHarness): void {
  harness.emitPiEvent('subagent:async-started', {
    id: WORKFLOW,
    mode: 'workflow',
    agent: 'workflow',
    pid: AGENT_STATUS_EXTENSION_SELF_PID
  })
}

function startChild(harness: AgentStatusExtensionHarness, id: string, parent = WORKFLOW): void {
  harness.emitPiEvent('subagent:async-started', {
    id,
    mode: 'single',
    pid: 4000,
    parentWorkflowRunId: parent
  })
}

function exitRunner(harness: AgentStatusExtensionHarness, runId: string): void {
  harness.emitPiEvent('subagent:process-terminal', { runId, state: 'observed' })
}

function complete(harness: AgentStatusExtensionHarness, id: string): void {
  harness.emitPiEvent('subagent:async-complete', { id, runId: id, state: 'complete' })
}

function childIds(payload: PostedPayload | undefined): string[] | undefined {
  return payload?.subagents?.map((child) => child.id)
}

function startAsync(harness: AgentStatusExtensionHarness, id: string, agent: string): void {
  harness.emitPiEvent('subagent:async-started', {
    id,
    mode: 'single',
    agent,
    task: '[REDACTED]',
    goal: '[REDACTED]',
    pid: 4000
  })
}

async function endTurn(harness: AgentStatusExtensionHarness): Promise<void> {
  await harness.callHook('agent_end', {}, idle)
  await harness.callHook('agent_settled', undefined, idle)
  await vi.advanceTimersByTimeAsync(0)
}

describe('Pi async subagent roster', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles after an async workflow whose awaited children never report completion', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startChild(harness, 'child-a')
    startChild(harness, 'child-b')
    await endTurn(harness)
    exitRunner(harness, 'child-a')
    exitRunner(harness, 'child-b')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(agentEndCount(harness)).toBe(0)

    // pi-subagents wakes the lead just before announcing only the workflow's completion.
    await harness.callHook('agent_start')
    complete(harness, WORKFLOW)
    await endTurn(harness)

    expect(postedHookNames(harness).at(-1)).toBe('agent_end')
  })

  it('settles as soon as the workflow completes when its children already exited', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startChild(harness, 'child-a')
    await endTurn(harness)
    exitRunner(harness, 'child-a')
    complete(harness, WORKFLOW)
    await vi.advanceTimersByTimeAsync(0)

    expect(agentEndCount(harness)).toBe(1)
  })

  it('settles after a foreground workflow whose awaited children never report completion', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startChild(harness, 'child-a', 'tool-call-1')
    startChild(harness, 'child-b', 'tool-call-1')
    exitRunner(harness, 'child-a')
    exitRunner(harness, 'child-b')
    await endTurn(harness)

    expect(agentEndCount(harness)).toBe(1)
  })

  it('settles once a child runner exits after its workflow already completed', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startChild(harness, 'child-a')
    await endTurn(harness)
    complete(harness, WORKFLOW)
    exitRunner(harness, 'child-a')
    await vi.advanceTimersByTimeAsync(500)
    expect(agentEndCount(harness)).toBe(0)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(agentEndCount(harness)).toBe(1)
  })

  it('keeps working while an explicit async child outlives its workflow', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startChild(harness, 'child-a')
    complete(harness, WORKFLOW)
    await endTurn(harness)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(agentEndCount(harness)).toBe(0)

    // The child's own completion and the wake turn land right after its runner exits.
    exitRunner(harness, 'child-a')
    await vi.advanceTimersByTimeAsync(150)
    await harness.callHook('agent_start')
    complete(harness, 'child-a')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(agentEndCount(harness)).toBe(0)

    await endTurn(harness)
    expect(agentEndCount(harness)).toBe(1)
  })

  it('ignores runner exits for runs it is not tracking', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    harness.emitPiEvent('subagent:async-started', { id: 'run-1', mode: 'single', pid: 4000 })
    await endTurn(harness)
    exitRunner(harness, 'other-run')
    harness.emitPiEvent('subagent:process-terminal', {})
    await vi.advanceTimersByTimeAsync(5_000)

    expect(agentEndCount(harness)).toBe(0)
  })

  it('accepts completion events that identify the run only by runId', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    harness.emitPiEvent('subagent:async-started', { id: 'run-1', mode: 'single', pid: 4000 })
    await endTurn(harness)
    harness.emitPiEvent('subagent:async-complete', { runId: 'run-1' })
    await vi.advanceTimersByTimeAsync(0)

    expect(agentEndCount(harness)).toBe(1)
  })

  it('keeps one runner-exit subscription and the roster across reloads', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startChild(harness, 'child-a', 'tool-call-1')
    harness.reload()
    expect(harness.piEventListenerCount('subagent:process-terminal')).toBe(1)

    exitRunner(harness, 'child-a')
    await endTurn(harness)
    expect(agentEndCount(harness)).toBe(1)
  })
})

// Roster shapes also mirror OMP 18.3.2's task:subagent:lifecycle.
describe('Pi child rows', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts each running pi-subagents child with its agent name, never its redacted task', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    startAsync(harness, 'run-scout', 'scout')
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness)).toEqual([
      {
        hook_event_name: 'agent_start',
        subagents: [
          { id: 'run-scout', state: 'working', startedAt: expect.any(Number), agentType: 'scout' }
        ]
      }
    ])
  })

  it('posts an OMP task child with its description', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    harness.emitPiEvent('task:subagent:lifecycle', {
      id: '0-explore',
      agent: 'explore',
      description: 'Map the auth module',
      detached: true,
      status: 'started',
      index: 0
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)?.subagents).toEqual([
      {
        id: '0-explore',
        state: 'working',
        startedAt: expect.any(Number),
        agentType: 'explore',
        description: 'Map the auth module'
      }
    ])
  })

  it('restates the roster when a child ends mid-turn', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startAsync(harness, 'run-a', 'scout')
    startAsync(harness, 'run-b', 'reviewer')
    await vi.advanceTimersByTimeAsync(0)
    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)

    const last = posts(harness).at(-1)
    expect(last?.hook_event_name).toBe('subagents_update')
    expect(childIds(last)).toEqual(['run-b'])
  })

  it('restates the roster while the lead waits, then completes once the last child ends', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startAsync(harness, 'run-a', 'scout')
    startAsync(harness, 'run-b', 'reviewer')
    await endTurn(harness)
    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'subagents_update' })
    expect(childIds(posts(harness).at(-1))).toEqual(['run-b'])

    complete(harness, 'run-b')
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toEqual({ hook_event_name: 'agent_end' })
    expect(
      posts(harness).filter((post) => post.hook_event_name === 'subagents_update')
    ).toHaveLength(1)
  })

  it('drops a child as soon as its runner exits, once per exit', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startAsync(harness, 'run-a', 'scout')
    startAsync(harness, 'run-b', 'reviewer')
    await vi.advanceTimersByTimeAsync(0)
    exitRunner(harness, 'run-a')
    exitRunner(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)

    const updates = posts(harness).filter((post) => post.hook_event_name === 'subagents_update')
    expect(updates).toHaveLength(1)
    expect(childIds(updates[0])).toEqual(['run-b'])
  })

  it('lets a queued post carry a roster change instead of adding an update behind it', async () => {
    const releases: (() => void)[] = []
    const harness = createAgentStatusExtensionHarness({
      kind: 'pi',
      fetchImpl: () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true }))
        })
    })
    await harness.callHook('agent_start')
    startAsync(harness, 'run-a', 'scout')
    startAsync(harness, 'run-b', 'reviewer')
    complete(harness, 'run-a')

    releases.shift()?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).map((post) => post.hook_event_name)).toEqual([
      'agent_start',
      'agent_start'
    ])
    expect(childIds(posts(harness)[1])).toEqual(['run-b'])
  })

  it('posts no subagents field for a pane without children', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('before_agent_start', { prompt: 'plain turn' })
    await harness.callHook('tool_execution_start', { toolName: 'bash', args: {} })
    await endTurn(harness)

    expect(posts(harness).some((post) => 'subagents' in post)).toBe(false)
  })

  it('keeps the roster details across an in-process reload', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    startAsync(harness, 'run-a', 'scout')
    await vi.advanceTimersByTimeAsync(0)
    harness.reload()
    await harness.callHook('tool_execution_start', { toolName: 'bash', args: {} })
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)?.subagents).toEqual([
      { id: 'run-a', state: 'working', startedAt: expect.any(Number), agentType: 'scout' }
    ])
  })

  it('forgets every child on an OMP session switch', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)
    await harness.callHook('session_switch', {}, {})
    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_start' })
    expect(posts(harness).at(-1)?.subagents).toBeUndefined()
  })

  it('posts one roster update when a runner exit precedes its completion', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startAsync(harness, 'run-a', 'scout')
    startAsync(harness, 'run-b', 'reviewer')
    await vi.advanceTimersByTimeAsync(0)
    exitRunner(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(150)
    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)

    const updates = posts(harness).filter((post) => post.hook_event_name === 'subagents_update')
    expect(updates.map(childIds)).toEqual([['run-b']])
  })

  it('leaves a scheduled OMP retry to carry a roster change', async () => {
    let attempts = 0
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      fetchImpl: async () => {
        attempts += 1
        if (attempts === 1) {
          throw new Error('Orca restarting')
        }
        return { ok: true }
      }
    })
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(250)

    expect(posts(harness).map((post) => post.hook_event_name)).toEqual([
      'agent_start',
      'agent_start'
    ])
    expect(posts(harness)[1]?.subagents).toBeUndefined()
  })

  it('forgets the previous session children when Pi starts a new session, not on reload', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    startAsync(harness, 'run-a', 'scout')
    await harness.callHook('session_start', { reason: 'reload' }, {})
    await harness.callHook('tool_execution_start', { toolName: 'bash', args: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(childIds(posts(harness).at(-1))).toEqual(['run-a'])

    await harness.callHook('session_start', { reason: 'new' }, {})
    await harness.callHook('tool_execution_start', { toolName: 'bash', args: {} })
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)?.subagents).toBeUndefined()
  })

  it('keeps a workflow run out of the rows while it still holds the pane', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startAsync(harness, 'run-a', 'scout')
    await endTurn(harness)
    expect(childIds(posts(harness).at(-1))).toEqual(['run-a'])

    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toEqual({ hook_event_name: 'subagents_update' })

    complete(harness, WORKFLOW)
    await vi.advanceTimersByTimeAsync(0)
    expect(postedHookNames(harness).slice(-1)).toEqual(['agent_end'])
    expect(posts(harness).some((post) => childIds(post)?.includes(WORKFLOW))).toBe(false)
  })

  it('settles the run its children held open when Pi starts a new session', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startAsync(harness, 'run-a', 'scout')
    await endTurn(harness)
    expect(agentEndCount(harness)).toBe(0)

    await harness.callHook('session_start', { reason: 'new' }, {})
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).slice(-2)).toEqual([
      { hook_event_name: 'agent_end' },
      { hook_event_name: 'session_start' }
    ])
  })
})
