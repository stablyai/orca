import { describe, expect, it } from 'vitest'

import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import type { ClaudeSession } from '../structured/claude-structured-session-state'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import { ClaudeChildWorkPublisher } from './claude-child-work-publisher'

function sessionWithChild(toolUseId = 'toolu_a1'): ClaudeSession {
  const childWork = new ClaudeChildWorkDecoder()
  childWork.observe({
    type: 'system',
    subtype: 'task_started',
    task_id: 'a1',
    tool_use_id: toolUseId,
    task_type: 'local_agent',
    description: 'Read files'
  })
  return {
    childWork,
    translator: undefined,
    prompts: { awaitsAnswer: () => false },
    events: undefined,
    providerSessionId: 's1',
    initialization: { claudeConfigDir: '/tmp/claude', cwd: '/tmp/ws' }
  } as unknown as ClaudeSession
}

function publisherFor(
  session: ClaudeSession,
  published: AgentChildWorkEvidence[][],
  readChildEffort: (session: ClaudeSession, agentId: string) => Promise<string | undefined>,
  now: () => number = () => 10
): ClaudeChildWorkPublisher {
  return new ClaudeChildWorkPublisher({
    sessions: new Map([['session-1', session]]),
    now,
    readChildEffort,
    onChildWorkEvidence: (_sessionId, evidence) => published.push(evidence)
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function publishedEfforts(published: AgentChildWorkEvidence[][]): AgentChildWorkEvidence[] {
  return published.flat().filter((edge) => edge.type === 'operation' && edge.effort !== undefined)
}

describe('ClaudeChildWorkPublisher', () => {
  it('publishes the effort its transcript probe finds', async () => {
    const published: AgentChildWorkEvidence[][] = []
    const session = sessionWithChild()
    publisherFor(session, published, async (_session, agentId) =>
      agentId === 'a1' ? 'high' : undefined
    ).publish('session-1', session)
    await Promise.resolve()

    expect(published[0]?.[0]).toMatchObject({ type: 'live', child: { handle: { id: 'a1' } } })
    expect(published.at(-1)?.[0]).toEqual({
      type: 'operation',
      observedAt: 10,
      childId: 'a1',
      effort: 'high'
    })
  })

  it('publishes no effort when the transcript has none', async () => {
    const published: AgentChildWorkEvidence[][] = []
    const session = sessionWithChild()
    publisherFor(session, published, async () => undefined).publish('session-1', session)
    await Promise.resolve()

    expect(published).toHaveLength(1)
  })

  it('waits for a transcript that lands seconds later, then publishes exactly once', async () => {
    let now = 0
    let reads = 0
    const published: AgentChildWorkEvidence[][] = []
    const session = sessionWithChild()
    const publisher = publisherFor(
      session,
      published,
      async () => {
        reads += 1
        return reads < 3 ? undefined : 'low'
      },
      () => now
    )

    publisher.publish('session-1', session)
    await Promise.resolve()
    expect(reads).toBe(1)

    now = 1_999
    publisher.publish('session-1', session)
    await Promise.resolve()
    expect(reads).toBe(1)

    now = 2_000
    publisher.publish('session-1', session)
    await Promise.resolve()
    expect(reads).toBe(2)

    now = 4_000
    publisher.publish('session-1', session)
    await Promise.resolve()
    expect(reads).toBe(3)

    now = 6_000
    publisher.publish('session-1', session)
    await Promise.resolve()
    expect(reads).toBe(3)

    const efforts = published
      .flat()
      .filter((edge) => edge.type === 'operation' && edge.effort !== undefined)
    expect(efforts).toEqual([
      { type: 'operation', observedAt: 4_000, childId: 'a1', effort: 'low' }
    ])
  })

  it('reads at most once per interval during a burst of frames', async () => {
    let now = 0
    let reads = 0
    const session = sessionWithChild()
    const publisher = publisherFor(
      session,
      [],
      async () => {
        reads += 1
        return undefined
      },
      () => now
    )

    for (let frame = 0; frame < 100; frame += 1) {
      publisher.publish('session-1', session)
    }
    await Promise.resolve()
    expect(reads).toBe(1)

    now = 1_999
    publisher.publish('session-1', session)
    await Promise.resolve()
    expect(reads).toBe(1)

    now = 2_000
    publisher.publish('session-1', session)
    await Promise.resolve()
    expect(reads).toBe(2)
  })

  it('stops probing after the attempt budget', async () => {
    let now = 0
    let reads = 0
    const session = sessionWithChild()
    const publisher = publisherFor(
      session,
      [],
      async () => {
        reads += 1
        return undefined
      },
      () => now
    )

    for (let interval = 0; interval < 40; interval += 1) {
      now = interval * 2_000
      publisher.publish('session-1', session)
      await Promise.resolve()
    }
    expect(reads).toBe(30)
  })

  it('discards an in-flight read when the child restarts', async () => {
    const first = deferred<string | undefined>()
    const second = deferred<string | undefined>()
    const reads = [first.promise, second.promise]
    let calls = 0
    const published: AgentChildWorkEvidence[][] = []
    const session = sessionWithChild('toolu_a1')
    const publisher = publisherFor(
      session,
      published,
      () => reads[calls++],
      () => 0
    )

    publisher.publish('session-1', session)
    expect(calls).toBe(1)

    // The first run ends, then the same child starts again under a new spawn call.
    session.childWork.observe({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'a1',
      tool_use_id: 'toolu_a1',
      status: 'completed'
    })
    session.childWork.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: 'a1',
      tool_use_id: 'toolu_a2',
      task_type: 'local_agent',
      description: 'Read files'
    })
    publisher.publish('session-1', session)
    expect(calls).toBe(2)

    first.resolve('low')
    await Promise.resolve()
    expect(publishedEfforts(published)).toEqual([])

    second.resolve('high')
    await Promise.resolve()
    expect(publishedEfforts(published)).toEqual([
      { type: 'operation', observedAt: 0, childId: 'a1', effort: 'high' }
    ])
  })

  it('discards an in-flight read when the same child resumes as a new run', async () => {
    const first = deferred<string | undefined>()
    const second = deferred<string | undefined>()
    const reads = [first.promise, second.promise]
    let calls = 0
    const published: AgentChildWorkEvidence[][] = []
    const session = sessionWithChild('toolu_a1')
    const publisher = publisherFor(
      session,
      published,
      () => reads[calls++],
      () => 0
    )

    publisher.publish('session-1', session)
    expect(calls).toBe(1)

    // A new run under the same id without an ending frame to mark it as a restart.
    const task = session.childWork.live.get('a1')
    if (!task) {
      throw new Error('expected a live child')
    }
    session.childWork.live.set('a1', { ...task, toolUseId: 'toolu_a2' })
    publisher.publish('session-1', session)
    expect(calls).toBe(2)

    first.resolve('low')
    await Promise.resolve()
    expect(publishedEfforts(published)).toEqual([])

    second.resolve('high')
    await Promise.resolve()
    expect(publishedEfforts(published)).toEqual([
      { type: 'operation', observedAt: 0, childId: 'a1', effort: 'high' }
    ])
  })
})
