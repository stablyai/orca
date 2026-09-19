import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { CodexSubagentExecutions } from './codex-subagent-executions'

const PRIMARY = 'primary'
const CHILD = 'child'

function turn(
  method: 'turn/started' | 'turn/completed',
  threadId: string,
  turnId: string,
  status = 'completed'
): CodexStructuredSessionEvent {
  return {
    type: 'notification',
    sessionId: 'session',
    method,
    threadId,
    params: { threadId, turn: { id: turnId, status } }
  }
}

function activity(parentTurn: string, kind = 'started'): CodexStructuredSessionEvent {
  return {
    type: 'notification',
    sessionId: 'session',
    threadId: PRIMARY,
    method: 'item/started',
    params: {
      threadId: PRIMARY,
      turnId: parentTurn,
      item: {
        type: 'subAgentActivity',
        id: `activity-${parentTurn}-${kind}`,
        kind,
        agentThreadId: CHILD,
        agentPath: '/root/task'
      }
    }
  }
}

function harness() {
  const executions = new CodexSubagentExecutions()
  const tracker = new CodexBackgroundTaskTracker(PRIMARY, executions)
  const rows = new Map<string, AgentJournalItemBody>()
  let refused = false
  const translator = createCodexJournalTranslator({
    primaryThreadId: () => PRIMARY,
    subagentExecutions: executions,
    sink: {
      appendItem: (identity, body) => rows.set(JSON.stringify(identity), body),
      appendTombstone: () => {},
      publish: () => {},
      tryAppendItem: (identity, body) => {
        if (refused) {
          return { accepted: false, reason: 'backpressure' }
        }
        rows.set(JSON.stringify(identity), body)
        return { accepted: true }
      }
    },
    schedule: (run) => {
      run()
      return () => {}
    }
  })
  function send(event: CodexStructuredSessionEvent) {
    const admission = translator.handle(event)
    if (admission.accepted && event.type === 'notification') {
      tracker.observe(event)
    }
    return admission
  }
  function state(parentTurn: string): string | undefined {
    for (const body of rows.values()) {
      if (body.kind !== 'message') {
        continue
      }
      for (const block of body.blocks) {
        if (block.type === 'subagent-group' && block.groupId === `${PRIMARY}:${parentTurn}`) {
          return block.agents[0]?.state
        }
      }
    }
    return undefined
  }
  return {
    send,
    tracker,
    state,
    refuse: (value: boolean) => {
      refused = value
    },
    dispose: () => translator.dispose()
  }
}

function firstRun(h: ReturnType<typeof harness>) {
  h.send(turn('turn/started', PRIMARY, 'parent-1'))
  h.send(turn('turn/started', CHILD, 'child-1'))
  h.send(activity('parent-1'))
  h.send(turn('turn/completed', CHILD, 'child-1'))
}

describe('shared child execution projection', () => {
  it('creates no execution record from activity without an owner turn', () => {
    const h = harness()
    h.send(activity('parent-1'))
    h.send(activity('parent-2', 'interacted'))
    expect(h.state('parent-1')).toBeUndefined()
    expect(h.state('parent-2')).toBeUndefined()
    expect(h.tracker.state).toBeNull()
    h.dispose()
  })

  it.each(['parent-1', 'parent-2'])(
    'reopens a child for real follow-up in %s and fences old execution events',
    (parent) => {
      const h = harness()
      firstRun(h)
      if (parent === 'parent-2') {
        h.send(turn('turn/completed', PRIMARY, 'parent-1'))
        h.send(turn('turn/started', PRIMARY, parent))
      }
      h.send(activity(parent, 'interacted'))
      expect(h.tracker.state).toBeNull()
      h.send(turn('turn/started', CHILD, 'child-2'))
      h.send(turn('turn/completed', PRIMARY, parent))
      expect(h.state(parent)).toBe('working')
      expect(h.tracker.state?.tasks).toHaveLength(1)
      h.send(turn('turn/completed', CHILD, 'child-1'))
      h.send(turn('turn/started', CHILD, 'child-1'))
      h.send(activity('parent-1', 'completed'))
      expect(h.state(parent)).toBe('working')
      expect(h.tracker.state?.tasks).toHaveLength(1)
      if (parent === 'parent-2') {
        expect(h.state('parent-1')).toBe('completed')
      }
      h.send(turn('turn/completed', CHILD, 'child-2'))
      expect(h.state(parent)).toBe('completed')
      expect(h.tracker.state).toBeNull()
      h.dispose()
    }
  )

  it('keeps an idle message from creating execution on either surface', () => {
    const h = harness()
    firstRun(h)
    h.send(turn('turn/completed', PRIMARY, 'parent-1'))
    h.send(activity('parent-2', 'interacted'))
    h.send(turn('turn/completed', PRIMARY, 'parent-2'))
    expect(h.state('parent-1')).toBe('completed')
    expect(h.state('parent-2')).toBeUndefined()
    expect(h.tracker.state).toBeNull()
    h.dispose()
  })

  it('keeps a late completion activity from retargeting a queued follow-up', () => {
    const h = harness()
    firstRun(h)
    h.send(turn('turn/completed', PRIMARY, 'parent-1'))
    h.send(activity('parent-2', 'interacted'))
    h.send(activity('parent-1', 'completed'))
    h.send(turn('turn/started', CHILD, 'child-2'))
    expect(h.state('parent-1')).toBe('completed')
    expect(h.state('parent-2')).toBe('working')
    expect(h.tracker.state?.tasks).toHaveLength(1)
    h.dispose()
  })

  it('keeps a message to a running child in the original execution group', () => {
    const h = harness()
    h.send(turn('turn/started', PRIMARY, 'parent-1'))
    h.send(turn('turn/started', CHILD, 'child-1'))
    h.send(activity('parent-1'))
    h.send(turn('turn/completed', PRIMARY, 'parent-1'))
    h.send(turn('turn/started', PRIMARY, 'parent-2'))
    h.send(activity('parent-2', 'interacted'))
    h.send(turn('turn/started', CHILD, 'child-1'))
    h.send(turn('turn/completed', PRIMARY, 'parent-2'))
    expect(h.tracker.state?.tasks).toHaveLength(1)
    expect(h.state('parent-2')).toBeUndefined()
    h.send(turn('turn/completed', CHILD, 'child-1'))
    expect(h.state('parent-1')).toBe('completed')
    expect(h.state('parent-2')).toBeUndefined()
    expect(h.tracker.state).toBeNull()
    h.dispose()
  })

  it('does not expose pending child settlement before journal admission and retries the same fact', () => {
    const h = harness()
    h.send(turn('turn/started', PRIMARY, 'parent-1'))
    h.send(activity('parent-1'))
    h.send(turn('turn/started', CHILD, 'child-1'))
    h.send(turn('turn/completed', PRIMARY, 'parent-1'))
    const complete = turn('turn/completed', CHILD, 'child-1')
    h.refuse(true)
    expect(h.send(complete)).toEqual({ accepted: false, reason: 'backpressure' })
    expect(h.tracker.state?.tasks).toHaveLength(1)
    expect(h.state('parent-1')).toBe('working')
    h.refuse(false)
    expect(h.send(complete)).toEqual({ accepted: true })
    expect(h.state('parent-1')).toBe('completed')
    expect(h.tracker.state).toBeNull()
    h.dispose()
  })
})
