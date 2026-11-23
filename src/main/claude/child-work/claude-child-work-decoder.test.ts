import { describe, expect, it } from 'vitest'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import { CLAUDE_CHILD_WAKE_LEASE_MS } from './claude-child-wake-lease'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'

const PARENT = 'toolu_parent'
const OWNER = 'owner_task'
const CHILD = 'child_task'
const OWNED_BY_OWNER = { toolu_child: OWNER }

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
    ...(parent ? { parent_task_id: parent } : {})
  }
}

function observe(
  decoder: ClaudeChildWorkDecoder,
  message: Record<string, unknown>
): AgentChildWorkEvidence[] {
  decoder.observe(message, (id) => OWNED_BY_OWNER[id as keyof typeof OWNED_BY_OWNER] ?? null)
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
  return evidence.flatMap((edge) =>
    edge.type === 'live' ? [[edge.child.handle.id, edge.child.state] as [string, string]] : []
  )
}

describe('a child ending wakes a finished subagent it was launched from', () => {
  it('shows the owner working again at once, as before', () => {
    const decoder = new ClaudeChildWorkDecoder()
    const evidence = finishOwnerThenChildEnds(decoder)
    expect(states(evidence)).toContainEqual([OWNER, 'working'])
  })

  it('settles the owner back to its recorded ending once the wake lease runs out', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    const endedAt = Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS
    const evidence = decoder.drain(endedAt)
    expect(evidence).toContainEqual({
      type: 'ended',
      observedAt: endedAt,
      handle: { idKind: 'task_id', id: OWNER, runId: PARENT },
      outcome: 'succeeded'
    })
  })

  it('leaves the owner working while the lease is still running', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    expect(decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS - 1_000)).toEqual([])
  })

  it('keeps the owner working when a frame names it inside the lease', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    // Claude did resume the owner: a frame for it proves the guess was right.
    observe(decoder, notification(OWNER, PARENT, 'completed'))
    expect(decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS * 2)).toEqual([])
  })

  it('restores the owner under its own id so later frames still route', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    const ended = decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS)
    expect(ended.map((edge) => edge.type)).toEqual(['ended'])
  })

  it('reports the next expiry so the host can restate the row without another frame', () => {
    const decoder = new ClaudeChildWorkDecoder()
    const before = Date.now()
    finishOwnerThenChildEnds(decoder)
    const expiry = decoder.wakeExpiryAt()
    expect(expiry).toBeGreaterThanOrEqual(before + CLAUDE_CHILD_WAKE_LEASE_MS)
    // The guess is spent: nothing is left to watch.
    decoder.drain(Number.MAX_SAFE_INTEGER)
    expect(decoder.wakeExpiryAt()).toBeUndefined()
  })

  it('does not hold a wake for an owner that never ended', () => {
    const decoder = new ClaudeChildWorkDecoder()
    observe(decoder, start(OWNER, PARENT))
    observe(decoder, start(CHILD, 'toolu_child'))
    observe(decoder, notification(CHILD, 'toolu_child', 'completed', OWNER))
    expect(decoder.wakeExpiryAt()).toBeUndefined()
  })
})
