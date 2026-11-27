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

  it('releases the wake when a roster entry reports the owner running', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    observe(decoder, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: OWNER, tool_use_id: PARENT, status: 'running', task_type: 'local_agent' }]
    })
    expect(decoder.wakeExpiryAt()).toBeUndefined()
    expect(decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS * 2)).toEqual([])
  })

  it('keeps the wake when a frame naming the owner is rejected as historical', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    // An older invocation's frame is ignored by the currency gate, so it must not release the lease:
    // otherwise the owner has no guess left and the row stays working for good.
    observe(decoder, {
      type: 'system',
      subtype: 'task_notification',
      task_id: OWNER,
      tool_use_id: 'toolu_parent_stale',
      status: 'completed'
    })
    expect(decoder.wakeExpiryAt()).toBeDefined()
    const evidence = decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS)
    expect(evidence.map((edge) => edge.type)).toEqual(['ended'])
  })

  it('accepts a running roster entry for the owner after its wake expired', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS)
    // The lease is spent and the owner reads done; a later running report proves the resume happened.
    const evidence = observe(decoder, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: OWNER, tool_use_id: PARENT, status: 'running', task_type: 'local_agent' }]
    })
    expect(states(evidence)).toContainEqual([OWNER, 'working'])
  })

  it.each([false, true])(
    'keeps a confirmed ending when the wake already expired: %s',
    (expired) => {
      const decoder = new ClaudeChildWorkDecoder()
      finishOwnerThenChildEnds(decoder)
      if (expired) {
        decoder.drain(NOW + CLAUDE_CHILD_WAKE_LEASE_MS)
      }
      observe(decoder, notification(OWNER, PARENT, 'completed'))
      expect(decoder.wakeExpiryAt()).toBeUndefined()
      vi.setSystemTime(NOW + CLAUDE_CHILD_WAKE_LEASE_MS + 1)
      decoder.drain(Date.now())
      const evidence = observe(decoder, {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: OWNER, tool_use_id: PARENT, status: 'running', task_type: 'local_agent' }
        ]
      })
      expect(states(evidence)).not.toContainEqual([OWNER, 'working'])
    }
  )

  it('still rejects an ended task that never had a wake', () => {
    const decoder = new ClaudeChildWorkDecoder()
    observe(decoder, start(OWNER, PARENT))
    observe(decoder, notification(OWNER, PARENT, 'completed'))
    const evidence = observe(decoder, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: OWNER, tool_use_id: PARENT, status: 'running', task_type: 'local_agent' }]
    })
    expect(states(evidence)).not.toContainEqual([OWNER, 'working'])
  })

  it('does not hold a wake for an owner that never ended', () => {
    const decoder = new ClaudeChildWorkDecoder()
    observe(decoder, start(OWNER, PARENT))
    observe(decoder, start(CHILD, 'toolu_child'))
    observe(decoder, notification(CHILD, 'toolu_child', 'completed', OWNER))
    expect(decoder.wakeExpiryAt()).toBeUndefined()
  })

  it('keeps the saved kind and name when a running report revives the owner', () => {
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
    // The owner's live record is gone, so the revival must read the saved task rather than the
    // roster entry, which carries only its id and status.
    const evidence = observe(decoder, {
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: OWNER, tool_use_id: PARENT, status: 'running' }]
    })
    const live = evidence.find((edge) => edge.type === 'live' && edge.child.handle.id === OWNER)
    expect(live?.type === 'live' && live.child.kind).toBe('agent')
    expect(live?.type === 'live' && live.child.name).toBe('explorer')
  })

  it('does not revive an expired owner from a metadata-only update', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS)
    // No running evidence: a description patch says nothing about the provider resuming the owner.
    const evidence = observe(decoder, {
      type: 'system',
      subtype: 'task_updated',
      task_id: OWNER,
      tool_use_id: PARENT,
      patch: { status: 'completed', error: 'late metadata' }
    })
    expect(states(evidence)).not.toContainEqual([OWNER, 'working'])
    expect(decoder.wakeExpiryAt()).toBeUndefined()
  })

  it('revives an expired owner from an update that reports it running', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS)
    const evidence = observe(decoder, {
      type: 'system',
      subtype: 'task_updated',
      task_id: OWNER,
      tool_use_id: PARENT,
      patch: { status: 'running' }
    })
    expect(states(evidence)).toContainEqual([OWNER, 'working'])
  })

  it('releases the wake when an admitted progress frame names the owner', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    // task_progress carries no status; the SDK only emits it for a running task, so an admitted
    // one proves the provider resumed the owner and must not let the lease revert it.
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

  it('releases the wake when an admitted update patch reports the owner running', () => {
    const decoder = new ClaudeChildWorkDecoder()
    finishOwnerThenChildEnds(decoder)
    // A running patch lives under patch.status, but the status gate only reads the envelope.
    observe(decoder, {
      type: 'system',
      subtype: 'task_updated',
      task_id: OWNER,
      tool_use_id: PARENT,
      patch: { status: 'running' }
    })
    expect(decoder.wakeExpiryAt()).toBeUndefined()
    expect(decoder.drain(Date.now() + CLAUDE_CHILD_WAKE_LEASE_MS * 2)).toEqual([])
  })
})
