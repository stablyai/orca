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
    const endedAt = Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS
    expect(decoder.wakeExpiryAt()).toBe(endedAt)
    expect(decoder.drain(endedAt - 1)).toEqual([])
    expect(decoder.drain(endedAt)).toEqual([
      {
        type: 'ended',
        observedAt: endedAt,
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
    observe(decoder, {
      type: 'system',
      subtype: 'task_progress',
      task_id: OWNER,
      tool_use_id: PARENT,
      summary: 'still working'
    })
    expect(decoder.wakeExpiryAt()).toBeUndefined()
    expect(decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS * 2)).toEqual([])
  })

  it('keeps the lease when a running report for the owner is from an older run', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    const stale = { task_id: OWNER, tool_use_id: 'toolu_parent_stale', status: 'running' }
    observe(decoder, { type: 'system', subtype: 'task_progress', ...stale })
    observe(decoder, { type: 'system', subtype: 'background_tasks_changed', tasks: [stale] })
    const evidence = decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS)
    expect(evidence.map((edge) => edge.type)).toEqual(['ended'])
  })

  it('never puts back the guessed ending over a real one that arrived inside the lease', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    observe(decoder, notification(OWNER, PARENT, 'completed'))
    expect(decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS)).toEqual([])
    // That run is over: a late frame from it must not reopen the row with no lease left.
    const late = observe(decoder, {
      type: 'system',
      subtype: 'task_progress',
      task_id: OWNER,
      tool_use_id: PARENT,
      summary: 'late'
    })
    expect(states(late)).toEqual([])
  })

  it('revives an expired owner, with its saved name, only from a report that it runs', () => {
    const decoder = new ClaudeChildWorkDecoder()
    observe(decoder, start(OWNER, PARENT))
    observe(decoder, {
      type: 'system',
      subtype: 'task_updated',
      task_id: OWNER,
      tool_use_id: PARENT,
      patch: { name: 'explorer', task_type: 'local_agent' }
    })
    observe(decoder, start(CHILD, 'toolu_child'))
    observe(decoder, notification(OWNER, PARENT, 'completed'))
    observe(decoder, notification(CHILD, 'toolu_child', 'completed', OWNER))
    decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS)
    const update = (patch: Record<string, unknown>) =>
      observe(decoder, {
        type: 'system',
        subtype: 'task_updated',
        task_id: OWNER,
        tool_use_id: PARENT,
        patch
      })
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
