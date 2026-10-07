import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AGENT_STATUS_MAX_SUBAGENTS } from '../../shared/agent-status-types'
import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'
import {
  agentEndCount,
  childIds,
  complete,
  endTurn,
  exitRunner,
  postedHookNames,
  posts,
  startAsync,
  startChild,
  startWorkflow,
  WORKFLOW
} from './agent-status-subagent-event-fixtures'

describe('Pi async subagent roster', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles again when an async child starts after the turn settled', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    await endTurn(harness)
    startChild(harness, 'late-child', 'tool-call-1')
    complete(harness, 'late-child')
    await vi.advanceTimersByTimeAsync(0)

    expect(agentEndCount(harness)).toBe(2)
  })

  it("does not spend a run's done on a child that starts before it is posted", async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    let idle = false
    const context = { isIdle: () => idle }
    await harness.callHook('agent_start')
    await harness.callHook('agent_end', {}, context)
    startChild(harness, 'quick-child', 'tool-call-1')
    complete(harness, 'quick-child')
    await harness.callHook('tool_execution_start', { toolName: 'bash' }, context)
    idle = true
    await vi.advanceTimersByTimeAsync(1_000)

    expect(postedHookNames(harness).at(-1)).toBe('agent_end')
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
    await harness.callHook('session_start')
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

  // Why: the generated cap is interpolated from the host's, so a drift would show up here
  // as an over-long roster the host would silently truncate on arrival.
  it('caps the posted roster at the host limit', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    for (let index = 0; index < AGENT_STATUS_MAX_SUBAGENTS + 4; index++) {
      startAsync(harness, `run-${index}`, 'scout')
    }
    await vi.advanceTimersByTimeAsync(0)

    expect(childIds(posts(harness).at(-1))).toHaveLength(AGENT_STATUS_MAX_SUBAGENTS)
    expect(childIds(posts(harness).at(-1))?.at(-1)).toBe(`run-${AGENT_STATUS_MAX_SUBAGENTS - 1}`)
  })

  it('posts nothing for the end of a run it is not tracking', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    complete(harness, 'unknown-run')
    await vi.advanceTimersByTimeAsync(0)

    expect(postedHookNames(harness)).toEqual(['agent_start'])
  })

  it('labels a reused child id from its latest start, and keeps a running child’s first label', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const start = (agent: string) =>
      harness.emitPiEvent('task:subagent:lifecycle', { id: '0-task', agent, status: 'started' })
    const labels = () =>
      posts(harness)
        .at(-1)
        ?.subagents?.map((child) => child.agentType)
    await harness.callHook('agent_start')
    start('explore')
    start('review')
    await vi.advanceTimersByTimeAsync(0)
    expect(labels()).toEqual(['explore'])

    harness.emitPiEvent('task:subagent:lifecycle', { id: '0-task', status: 'completed' })
    start('review')
    await vi.advanceTimersByTimeAsync(0)
    expect(labels()).toEqual(['review'])

    await harness.callHook('session_switch', { reason: 'new' }, {})
    start('plan')
    await vi.advanceTimersByTimeAsync(0)
    expect(labels()).toEqual(['plan'])
  })

  it('posts no subagents field for a pane without children', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('before_agent_start', { prompt: 'plain turn' })
    await harness.callHook('tool_execution_start', { toolName: 'bash', args: {} })
    await endTurn(harness)

    expect(posts(harness).some((post) => 'subagents' in post)).toBe(false)
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
        if (attempts === 2) {
          throw new Error('Orca restarting')
        }
        return { ok: true }
      }
    })
    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(0)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(250)

    expect(posts(harness).map((post) => post.hook_event_name)).toEqual([
      'agent_start',
      'agent_start',
      'agent_start'
    ])
    expect(childIds(posts(harness)[1])).toEqual(['c1'])
    expect(posts(harness)[2]?.subagents).toBeUndefined()
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
})
