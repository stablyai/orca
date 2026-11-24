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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publisher only reads childWork, events and the session identity the reader receives.
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
