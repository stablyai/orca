import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import { CLAUDE_CHILD_WAKE_LEASE_MS } from './claude-child-wake-lease'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'

const NOW = 1_700_000_000_000

function useFixedClock(): void {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
}

afterEach(() => {
  vi.useRealTimers()
})

const PARENT = 'toolu_parent'
const OWNER = 'owner_task'
const CHILD = 'child_task'
const OWNED_BY_OWNER: Readonly<Record<string, string>> = { toolu_child: OWNER }

/** Spawn a subagent task; `owner` names the subagent that made the spawn call. */
function start(taskId: string, toolUseId: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    task_type: 'local_agent',
    status: 'running'
  }
}

function notification(
  taskId: string,
  toolUseId: string,
  status: string,
  parent?: string
): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: toolUseId,
    status,
    summary: `${taskId} summary`,
    ...(parent ? { parent_task_id: parent } : {})
  }
}

function observe(
  decoder: ClaudeChildWorkDecoder,
  message: Record<string, unknown>
): AgentChildWorkEvidence[] {
  decoder.observe(message, (id) => OWNED_BY_OWNER[id] ?? null)
  return decoder.drain(Date.now())
}

/** The owner subagent finishes its turn; its child keeps running and ends afterwards. */
function finishOwnerThenChildEnds(decoder: ClaudeChildWorkDecoder): AgentChildWorkEvidence[] {
  observe(decoder, start(OWNER, PARENT))
  observe(decoder, start(CHILD, 'toolu_child'))
  observe(decoder, notification(OWNER, PARENT, 'completed'))
  return observe(decoder, notification(CHILD, 'toolu_child', 'completed', OWNER))
}

function elapse(ms: number): void {
  vi.advanceTimersByTime(ms)
}

function progress(taskId: string, toolUseId: string): Record<string, unknown> {
  return { type: 'system', subtype: 'task_progress', task_id: taskId, tool_use_id: toolUseId }
}

function states(evidence: AgentChildWorkEvidence[]): [string, string][] {
  return evidence.flatMap((edge): [string, string][] =>
    edge.type === 'live' ? [[edge.child.handle.id, edge.child.state]] : []
  )
}

describe('a child ending wakes a finished subagent it was launched from', () => {
  beforeEach(useFixedClock)

  it('settles the owner back to its recorded ending once the wake lease runs out', () => {
    const decoder = new ClaudeChildWorkDecoder()
    expect(states(finishOwnerThenChildEnds(decoder))).toContainEqual([OWNER, 'working'])
    expect(decoder.wakeExpiryAt()).toBe(performance.now() + CLAUDE_CHILD_WAKE_LEASE_MS)
    // A wall-clock correction backwards must not stretch the lease.
    vi.setSystemTime(NOW - 3_600_000)
    elapse(CLAUDE_CHILD_WAKE_LEASE_MS - 1)
    expect(decoder.drain(Date.now())).toEqual([])
    elapse(1)
    expect(decoder.drain(Date.now())).toEqual([
      {
        type: 'ended',
        observedAt: Date.now(),
        handle: { idKind: 'task_id', id: OWNER, runId: PARENT },
        outcome: 'succeeded',
        lastMessage: `${OWNER} summary`
      }
    ])
    expect(decoder.wakeExpiryAt()).toBeUndefined()
  })

  it('keeps the owner working when Claude does resume it inside the lease', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    observe(decoder, progress(OWNER, PARENT))
    expect(decoder.wakeExpiryAt()).toBeUndefined()
    elapse(CLAUDE_CHILD_WAKE_LEASE_MS * 2)
    expect(decoder.drain(Date.now())).toEqual([])
  })

  it('keeps the lease for a frame from an older run, a pending update, or a roster that merely lists the owner', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    observe(decoder, { ...progress(OWNER, 'toolu_parent_stale'), status: 'running' })
    observe(decoder, {
      type: 'system',
      subtype: 'task_updated',
      task_id: OWNER,
      tool_use_id: PARENT,
      patch: { status: 'pending' }
    })
    observe(decoder, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: OWNER, task_type: 'local_agent', description: 'owner' }]
    })
    elapse(CLAUDE_CHILD_WAKE_LEASE_MS)
    expect(decoder.drain(Date.now()).map((edge) => edge.type)).toEqual(['ended'])
  })

  it('lets a real ending stand, inside the lease or after it, against late frames of that run', () => {
    const inside = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(inside)
    observe(inside, notification(OWNER, PARENT, 'completed'))
    elapse(CLAUDE_CHILD_WAKE_LEASE_MS)
    expect(inside.drain(Date.now())).toEqual([])
    expect(states(observe(inside, progress(OWNER, PARENT)))).toEqual([])

    const after = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(after)
    elapse(CLAUDE_CHILD_WAKE_LEASE_MS)
    after.drain(Date.now())
    observe(after, notification(OWNER, PARENT, 'completed'))
    expect(states(observe(after, progress(OWNER, PARENT)))).toEqual([])
  })

  it('revives an expired owner, with its saved name, only from a report that it runs', () => {
    const decoder = new ClaudeChildWorkDecoder()
    observe(decoder, start(OWNER, PARENT))
    const update = (patch: Record<string, unknown>) =>
      observe(decoder, {
        type: 'system',
        subtype: 'task_updated',
        task_id: OWNER,
        tool_use_id: PARENT,
        patch
      })
    update({ name: 'explorer', task_type: 'local_agent' })
    observe(decoder, start(CHILD, 'toolu_child'))
    observe(decoder, notification(OWNER, PARENT, 'completed'))
    observe(decoder, notification(CHILD, 'toolu_child', 'completed', OWNER))
    elapse(CLAUDE_CHILD_WAKE_LEASE_MS)
    decoder.drain(Date.now())
    expect(states(update({ description: 'late metadata' }))).toEqual([])
    const live = update({ status: 'running' }).find(
      (edge) => edge.type === 'live' && edge.child.handle.id === OWNER
    )
    expect(live?.type === 'live' && [live.child.state, live.child.kind, live.child.name]).toEqual([
      'working',
      'agent',
      'explorer'
    ])
  })
})
