import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'
import {
  agentEndCount,
  childIds,
  complete,
  endTurn,
  exitRunner,
  idle,
  postedHookNames,
  normalizedOmpPosts,
  posts,
  startAsync,
  startChild,
  startWorkflow,
  WORKFLOW
} from './agent-status-subagent-event-fixtures'

// Orderings mirror runs recorded from Pi 0.87.1 with pi-subagents 0.71.0: a session change or
// /reload shuts the old registration down and runs the factory again on a fresh `pi.events`.
function session(id: string) {
  return {
    isIdle: () => true,
    sessionManager: { getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl` }
  }
}

function createPi(fetchImpl?: () => Promise<unknown>): AgentStatusExtensionHarness {
  return createAgentStatusExtensionHarness({ kind: 'pi', existsSync: () => true, fetchImpl })
}

async function holdRunOpen(harness: AgentStatusExtensionHarness, sessionId = 'A'): Promise<void> {
  await harness.callHook('session_start', { reason: 'startup' }, session(sessionId))
  await harness.callHook('agent_start', {}, session(sessionId))
  startAsync(harness, 'run-a', 'scout')
  await endTurn(harness)
}

describe('Pi session changes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    ['new', undefined],
    ['resume', '/sessions/B.jsonl'],
    ['fork', '/sessions/B.jsonl']
  ] as const)(
    'ends the run its children held open under the old session on %s, before the next one starts',
    async (reason, target) => {
      const harness = createPi()
      await holdRunOpen(harness)
      expect(agentEndCount(harness)).toBe(0)

      await harness.replacePiSession(reason, target)
      await harness.callHook('session_start', { reason }, session('B'))
      await vi.advanceTimersByTimeAsync(0)

      expect(posts(harness).slice(-2)).toEqual([
        {
          hook_event_name: 'agent_end',
          session_id: 'A',
          session_file: '/sessions/A.jsonl',
          session_boundary: true
        },
        { hook_event_name: 'session_start', session_id: 'B', session_file: '/sessions/B.jsonl' }
      ])
    }
  )

  it('ends the run for a Pi too old to say why it shut the session down', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    await harness.callHook('session_shutdown')
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end', session_id: 'A' })
  })

  it('posts nothing on quit, even with children still running', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    const sent = posts(harness).length
    await harness.callHook('session_shutdown', { reason: 'quit' })
    await vi.advanceTimersByTimeAsync(5_000)

    expect(posts(harness)).toHaveLength(sent)
  })

  it('re-opens the run for a child of the next session after a turn the old one cut off', async () => {
    const harness = createPi()
    await harness.callHook('session_start', { reason: 'startup' }, session('A'))
    await harness.callHook('agent_start', {}, session('A'))
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    startAsync(harness, 'run-b', 'scout')
    complete(harness, 'run-b')
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end', session_id: 'B' })
    expect(posts(harness).at(-1)).not.toHaveProperty('session_boundary')
  })

  it('keeps a completion that was still waiting to be sent when the session changed', async () => {
    const releases: (() => void)[] = []
    const harness = createPi(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true }))
        })
    )
    await harness.callHook('session_start', { reason: 'startup' }, session('A'))
    await harness.callHook('agent_start', {}, session('A'))
    // Pi aborts the turn before it shuts the session down; that completion queues behind the post in flight.
    await endTurn(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))

    while (releases.length > 0) {
      releases.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(posts(harness).slice(-2)).toMatchObject([
      { hook_event_name: 'agent_end', session_id: 'A' },
      { hook_event_name: 'session_start', session_id: 'B' }
    ])
    // A turn that really finished is a completion, not a session boundary.
    expect(posts(harness).at(-2)).not.toHaveProperty('session_boundary')
  })

  it('gives up on a completion Orca keeps refusing, then sends what came after', async () => {
    let attempts = 0
    const harness = createPi(async () => {
      attempts += 1
      if (attempts >= 3 && attempts <= 6) {
        throw new Error('Orca down')
      }
      return { ok: true }
    })
    await holdRunOpen(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await vi.advanceTimersByTimeAsync(5_000)

    expect(agentEndCount(harness)).toBe(4)
    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'session_start',
      session_id: 'B'
    })
  })

  it('posts nothing for an old session whose run already ended', async () => {
    const harness = createPi()
    await harness.callHook('agent_start', {}, session('A'))
    await endTurn(harness)
    expect(agentEndCount(harness)).toBe(1)

    await harness.replacePiSession('fork', '/sessions/B.jsonl')
    await vi.advanceTimersByTimeAsync(0)

    expect(agentEndCount(harness)).toBe(1)
  })

  it('delivers the old session’s completion ahead of a new session posted behind an in-flight delivery', async () => {
    const releases: (() => void)[] = []
    const harness = createPi(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true }))
        })
    )
    await holdRunOpen(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    // A child of the new session must not ride on the old session's last post.
    startAsync(harness, 'run-b', 'scout')

    while (releases.length > 0) {
      releases.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    const completion = posts(harness).find((post) => post.hook_event_name === 'agent_end')
    expect(completion).toMatchObject({ session_id: 'A' })
    expect(completion?.subagents).toBeUndefined()
    expect(postedHookNames(harness).slice(-2)).toEqual(['agent_end', 'agent_start'])
    expect(posts(harness).at(-1)).toMatchObject({ session_id: 'B' })
    expect(childIds(posts(harness).at(-1))).toEqual(['run-b'])
  })

  it('retries the old session’s completion before sending anything newer', async () => {
    let attempts = 0
    const harness = createPi(async () => {
      attempts += 1
      // The close-out follows session_start and agent_start; fail its first delivery.
      if (attempts === 3) {
        throw new Error('Orca restarting')
      }
      return { ok: true }
    })
    await holdRunOpen(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await vi.advanceTimersByTimeAsync(0)
    // The new session's post waits out the backoff behind the old session's completion.
    expect(postedHookNames(harness).at(-1)).toBe('agent_end')
    expect(agentEndCount(harness)).toBe(1)
    await vi.advanceTimersByTimeAsync(250)

    expect(posts(harness).slice(-3)).toMatchObject([
      { hook_event_name: 'agent_end', session_id: 'A' },
      { hook_event_name: 'agent_end', session_id: 'A' },
      { hook_event_name: 'session_start', session_id: 'B' }
    ])
  })

  it('stops listening once the old session is closed out', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    await harness.callHook('session_shutdown', { reason: 'new' })
    await vi.advanceTimersByTimeAsync(0)
    const sent = posts(harness).length

    // Another extension's shutdown handler can still be running while pi-subagents emits here.
    startAsync(harness, 'run-late', 'scout')
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness)).toHaveLength(sent)

    await harness.replacePiSession('new')
    await harness.callHook('agent_start', {}, session('B'))
    await endTurn(harness)
    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end' })
    expect(
      posts(harness)
        .slice(sent)
        .some((post) => post.subagents)
    ).toBe(false)
  })

  it('leaves no timer of the old session running', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    exitRunner(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)

    await harness.replacePiSession('new')
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not bring back a child whose runner had already exited', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    exitRunner(harness, 'run-a')
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await harness.callHook('session_start', { reason: 'resume' }, session('A'))
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'session_start',
      session_id: 'A'
    })
  })

  it('brings a session’s children back when it is resumed, and ends the run when they finish', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await harness.callHook('session_start', { reason: 'resume' }, session('A'))
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_start', session_id: 'A' })
    expect(posts(harness).at(-1)?.subagents).toEqual([
      { id: 'run-a', state: 'working', startedAt: expect.any(Number), agentType: 'scout' }
    ])

    // pi-subagents reports the run's completion to the resumed session, finished or not.
    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toEqual({
      hook_event_name: 'agent_end',
      session_id: 'A',
      session_file: '/sessions/A.jsonl'
    })
  })

  it('restores a session’s children once, not on every later resume', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await harness.callHook('session_start', { reason: 'resume' }, session('A'))
    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    await harness.replacePiSession('new')
    await harness.callHook('session_start', { reason: 'new' }, session('B'))
    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await harness.callHook('session_start', { reason: 'resume' }, session('A'))
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'session_start',
      session_id: 'A'
    })
    expect(posts(harness).at(-1)?.subagents).toBeUndefined()
  })

  it('keeps the children across a resume into the same session file', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await harness.callHook('session_start', { reason: 'resume' }, session('A'))
    await vi.advanceTimersByTimeAsync(0)
    expect(agentEndCount(harness)).toBe(0)

    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(agentEndCount(harness)).toBe(1)
  })
})

describe('Pi /reload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the children and the hold across a reload', async () => {
    const harness = createPi()
    await holdRunOpen(harness)
    await harness.reloadPi()
    await harness.callHook('session_start', { reason: 'reload' }, session('A'))
    expect(harness.piEventListenerCount('subagent:async-complete')).toBe(1)
    expect(harness.piEventListenerCount('subagent:process-terminal')).toBe(1)

    // A turn that ends while the pre-reload child still runs must not report done.
    await harness.callHook('agent_start', {}, session('A'))
    await vi.advanceTimersByTimeAsync(0)
    expect(childIds(posts(harness).at(-1))).toEqual(['run-a'])
    await endTurn(harness)
    expect(agentEndCount(harness)).toBe(0)

    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(postedHookNames(harness).at(-1)).toBe('agent_end')
    expect(agentEndCount(harness)).toBe(1)
  })

  it('keeps the turn counters across a reload, so a child starting afterwards is not read as late', async () => {
    const harness = createPi()
    await harness.callHook('agent_start', {}, session('A'))
    await harness.reloadPi()
    startAsync(harness, 'run-a', 'scout')
    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(agentEndCount(harness)).toBe(0)

    await endTurn(harness)
    expect(agentEndCount(harness)).toBe(1)
  })

  it('releases a workflow’s pre-reload children when the workflow ends', async () => {
    const harness = createPi()
    await harness.callHook('agent_start', {}, session('A'))
    startWorkflow(harness)
    startChild(harness, 'child-a')
    await endTurn(harness)
    // Pi drops the old registration's runner-exit events, so child-a never reports its end.
    await harness.reloadPi()
    complete(harness, WORKFLOW)
    await vi.advanceTimersByTimeAsync(0)

    expect(agentEndCount(harness)).toBe(1)
    expect(posts(harness).at(-1)?.subagents).toBeUndefined()
  })

  it('drops the rows of pre-reload children released while the turn is still running', async () => {
    const harness = createPi()
    await harness.callHook('agent_start', {}, session('A'))
    startWorkflow(harness)
    startChild(harness, 'child-a')
    await harness.reloadPi()
    complete(harness, WORKFLOW)
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)).toEqual({ hook_event_name: 'subagents_update' })
  })

  it.each(['reload', 'resume'] as const)(
    'settles an exited runner after same-session %s without another turn',
    async (reason) => {
      const harness = createPi()
      await harness.callHook('session_start', {}, session('A'))
      await harness.callHook('agent_start', {}, session('A'))
      startChild(harness, 'child-a', 'tool-call-1')
      await endTurn(harness)
      exitRunner(harness, 'child-a')
      await vi.advanceTimersByTimeAsync(1_000)
      await (reason === 'reload'
        ? harness.reloadPi()
        : harness.replacePiSession('resume', '/sessions/A.jsonl'))
      await harness.callHook('session_start', { reason }, session('A'))
      await vi.advanceTimersByTimeAsync(999)
      expect(agentEndCount(harness)).toBe(0)
      await vi.advanceTimersByTimeAsync(1)

      expect(agentEndCount(harness)).toBe(1)
      expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end', session_id: 'A' })
      expect(posts(harness).at(-1)?.subagents).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['new', 'quit'] as const)(
    'clears runner grace when the session ends on %s',
    async (reason) => {
      const harness = createPi()
      await holdRunOpen(harness)
      exitRunner(harness, 'run-a')
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      await harness.callHook('session_shutdown', { reason })
      await vi.advanceTimersByTimeAsync(0)
      const completionCount = agentEndCount(harness)
      await vi.advanceTimersByTimeAsync(5_000)

      expect(agentEndCount(harness)).toBe(completionCount)
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})

describe('children that start outside a turn', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-opens a finished OMP run for a late child and ends it when the child does', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('agent_start')
    await harness.callHook('agent_end', {})
    await vi.advanceTimersByTimeAsync(0)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'w1', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'w1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(0)

    expect(postedHookNames(harness)).toEqual([
      'agent_start',
      'agent_end',
      'agent_start',
      'agent_end'
    ])
  })

  it('ends a run for a child that started before any turn in this session', async () => {
    const harness = createPi()
    startAsync(harness, 'run-a', 'scout')
    await vi.advanceTimersByTimeAsync(0)
    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)

    expect(postedHookNames(harness)).toEqual(['agent_start', 'agent_end'])
  })

  it('keeps working when a dialog closes while a child runs, whether or not the turn has ended', async () => {
    const harness = createPi()
    await harness.callHook('agent_start')
    startAsync(harness, 'run-a', 'scout')
    await harness.callHook('ui_prompt_start', {})
    await harness.callHook('ui_prompt_end', {}, idle)
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'ui_prompt_end',
      is_idle: false
    })

    await endTurn(harness)
    await harness.callHook('ui_prompt_start', {})
    await harness.callHook('ui_prompt_end', {}, idle)
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toMatchObject({
      hook_event_name: 'ui_prompt_end',
      is_idle: false
    })
    expect(childIds(posts(harness).at(-1))).toEqual(['run-a'])

    complete(harness, 'run-a')
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toEqual({ hook_event_name: 'agent_end' })
  })
})

describe('OMP session switches', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // OMP keeps one registration and one SessionManager across a switch.
  function ompSession() {
    let id = 'A'
    const context = {
      isIdle: () => true,
      hasPendingMessages: () => false,
      getAsyncJobSnapshot: () => ({ running: [] }),
      sessionManager: { getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl` }
    }
    return { context, switchTo: (next: string) => (id = next) }
  }

  async function holdOmpRunOpen(harness: AgentStatusExtensionHarness, context: HookContext) {
    await harness.callHook('agent_start', {}, context)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', agent: 'task', status: 'started' })
    await harness.callHook('agent_end', {}, context)
    await vi.advanceTimersByTimeAsync(0)
  }

  it('ends the held run under the session that ran it and forgets its children', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { context, switchTo } = ompSession()
    await holdOmpRunOpen(harness, context)
    expect(normalizedOmpPosts(harness).at(-1)?.payload).toMatchObject({
      state: 'working',
      subagents: [{ id: 'c1' }]
    })

    switchTo('B')
    await harness.callHook(
      'session_switch',
      { reason: 'new', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(normalizedOmpPosts(harness)).toContainEqual(
      expect.objectContaining({
        providerSession: expect.objectContaining({ id: 'A' }),
        payload: expect.objectContaining({ state: 'done', sessionBoundary: true })
      })
    )
    expect(normalizedOmpPosts(harness).at(-1)).toMatchObject({
      providerSession: { id: 'B' },
      payload: { state: 'done', sessionBoundary: true }
    })
    expect(normalizedOmpPosts(harness).at(-1)?.payload.subagents).toBeUndefined()

    await harness.callHook('agent_start', {}, context)
    await vi.advanceTimersByTimeAsync(0)
    expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_start', session_id: 'B' })
    expect(posts(harness).at(-1)?.subagents).toBeUndefined()
  })

  it('ends a turn the switch cut off, under the session that ran it', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { context, switchTo } = ompSession()
    await harness.callHook('agent_start', {}, context)
    switchTo('B')
    await harness.callHook(
      'session_switch',
      { reason: 'new', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(normalizedOmpPosts(harness)).toContainEqual(
      expect.objectContaining({
        providerSession: expect.objectContaining({ id: 'A' }),
        payload: expect.objectContaining({ state: 'done', sessionBoundary: true })
      })
    )
    expect(normalizedOmpPosts(harness).at(-1)).toMatchObject({
      providerSession: { id: 'B' },
      payload: { state: 'done', sessionBoundary: true }
    })
  })

  it('keeps the children when OMP reloads the same session', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { context } = ompSession()
    await holdOmpRunOpen(harness, context)
    await harness.callHook(
      'session_switch',
      { reason: 'resume', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(normalizedOmpPosts(harness).at(-1)?.payload).toMatchObject({
      state: 'working',
      subagents: [{ id: 'c1' }]
    })

    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(normalizedOmpPosts(harness).at(-1)).toMatchObject({
      providerSession: { id: 'A' },
      payload: { state: 'done' }
    })
  })

  it.each(['fork', 'resume'] as const)(
    'keeps the children on a %s into another session, where OMP leaves them running',
    async (reason) => {
      const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
      const { context, switchTo } = ompSession()
      await holdOmpRunOpen(harness, context)
      switchTo('B')
      await harness.callHook(
        'session_switch',
        { reason, previousSessionFile: '/sessions/A.jsonl' },
        context
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(normalizedOmpPosts(harness).at(-1)).toMatchObject({
        providerSession: { id: 'B' },
        payload: { state: 'working', subagents: [{ id: 'c1' }] }
      })

      harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', status: 'completed' })
      await vi.advanceTimersByTimeAsync(0)
      expect(normalizedOmpPosts(harness).at(-1)).toMatchObject({
        providerSession: { id: 'B' },
        payload: { state: 'done' }
      })
    }
  )

  it('ends the held run when OMP branches the session', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { context, switchTo } = ompSession()
    await holdOmpRunOpen(harness, context)
    switchTo('B')
    await harness.callHook('session_branch', { previousSessionFile: '/sessions/A.jsonl' }, context)
    await vi.advanceTimersByTimeAsync(0)

    expect(normalizedOmpPosts(harness)).toContainEqual(
      expect.objectContaining({
        providerSession: expect.objectContaining({ id: 'A' }),
        payload: expect.objectContaining({ state: 'done', sessionBoundary: true })
      })
    )
    expect(normalizedOmpPosts(harness).at(-1)).toMatchObject({
      providerSession: { id: 'B' },
      payload: { state: 'done', sessionBoundary: true }
    })
    expect(normalizedOmpPosts(harness).at(-1)?.payload.subagents).toBeUndefined()
  })

  it('keeps a completion that was still waiting to be sent when OMP starts a new session', async () => {
    const releases: (() => void)[] = []
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      fetchImpl: () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true }))
        })
    })
    const { context, switchTo } = ompSession()
    await harness.callHook('agent_start', {}, context)
    await harness.callHook('agent_end', {}, context)
    switchTo('B')
    await harness.callHook(
      'session_switch',
      { reason: 'new', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    await harness.callHook('agent_start', {}, context)

    while (releases.length > 0) {
      releases.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(posts(harness).slice(-2)).toMatchObject([
      { hook_event_name: 'agent_end', session_id: 'A' },
      { hook_event_name: 'agent_start', session_id: 'B' }
    ])
  })

  it.each(['omp', 'pi'] as const)(
    'takes over a roster and its subscriptions that an older build left on the %s bus',
    async (kind) => {
      const harness = createAgentStatusExtensionHarness({
        kind,
        sharedEventBus: true,
        seedEventBus: (bus) => {
          Object.assign(bus, {
            __orcaPiSubagents: {
              active: new Set(['old-child']),
              waiting: false,
              listener: () => {},
              runnerExitListener: () => {}
            }
          })
        }
      })
      expect(harness.piEventListenerCount('task:subagent:lifecycle')).toBe(0)
      expect(harness.piEventListenerCount('subagent:process-terminal')).toBe(0)

      await harness.callHook('agent_start')
      await vi.advanceTimersByTimeAsync(0)
      expect(childIds(posts(harness).at(-1))).toEqual(['old-child'])
    }
  )

  it('resumes an idle session without reporting a completed turn', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { context } = ompSession()
    await harness.callHook(
      'session_switch',
      { reason: 'resume', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(normalizedOmpPosts(harness).at(-1)).toMatchObject({
      providerSession: { id: 'A' },
      payload: { state: 'done', sessionBoundary: true }
    })
    expect(normalizedOmpPosts(harness).at(-1)?.payload.mainAgent).toBeUndefined()
  })

  it('keeps the next session’s children off the old session’s last post', async () => {
    const releases: (() => void)[] = []
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      fetchImpl: () =>
        new Promise((resolve) => {
          releases.push(() => resolve({ ok: true }))
        })
    })
    const { context, switchTo } = ompSession()
    await holdOmpRunOpen(harness, context)
    switchTo('B')
    await harness.callHook(
      'session_switch',
      { reason: 'new', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c2', agent: 'task', status: 'started' })

    while (releases.length > 0) {
      releases.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
    }
    const completion = posts(harness).find((post) => post.hook_event_name === 'agent_end')
    expect(completion).toMatchObject({ session_id: 'A' })
    expect(completion?.subagents).toBeUndefined()
    expect(childIds(posts(harness).at(-1))).toEqual(['c2'])
  })

  it('ends a turn that a reload of the same session cut off', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const { context } = ompSession()
    await harness.callHook('agent_start', {}, context)
    await harness.callHook(
      'session_switch',
      { reason: 'resume', previousSessionFile: '/sessions/A.jsonl' },
      context
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(normalizedOmpPosts(harness).at(-1)?.payload).toMatchObject({
      state: 'done',
      sessionBoundary: true
    })

    // The turn is over, so a child that starts now re-opens the run.
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'w1', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)
    expect(normalizedOmpPosts(harness).at(-1)?.payload).toMatchObject({
      state: 'working',
      subagents: [{ id: 'w1' }]
    })
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'w1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(0)
    expect(normalizedOmpPosts(harness).at(-1)?.payload.state).toBe('done')
  })

  it('keeps describing the lead’s children after a task child registers on its own bus', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('session_start')
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)
    harness.registerTaskChild()
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c2', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)

    expect(childIds(posts(harness).at(-1))).toEqual(['c1', 'c2'])
  })

  it('ignores a task child’s own subagents, which run on that child’s bus', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('agent_start')
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)
    const emitOnChildBus = harness.registerTaskChild()
    emitOnChildBus('task:subagent:lifecycle', { id: 'g1', agent: 'task', status: 'started' })
    emitOnChildBus('task:subagent:lifecycle', { id: 'g1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(0)

    expect(postedHookNames(harness)).toEqual(['agent_start', 'agent_start'])
  })
})
