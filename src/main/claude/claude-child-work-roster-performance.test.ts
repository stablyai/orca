import { expect, it } from 'vitest'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'
import { createAgentStatusStore } from '../../shared/agent-status/store/agent-status-store'
import { createAgentChildWorkAdmission } from '../../shared/agent-status/child-work/agent-status-child-work-admission'
import { reconcileAgentChildWorkEvidence } from '../../shared/agent-status/child-work/agent-status-child-work-reconciliation'
import { parent } from './claude-child-work-producer-harness.test-fixture'

it('emits only new or changed roster facts at10 and100 live tasks', () => {
  for (const count of [10, 100]) {
    const decoder = new ClaudeChildWorkDecoder()
    const store = createAgentStatusStore({ epoch: 'roster-perf', mode: 'authority' })
    store.applyMutation({ parent: { subject: parent } })
    let minted = 0
    const admission = createAgentChildWorkAdmission(store, {
      mintChildWorkId: () => `child-${++minted}`
    })
    let clock = 1_700_000_000_000
    let rosterEdges = 0
    let rosterWrites = 0
    const feed = (message: Record<string, unknown>, rosterBound = 0) => {
      decoder.observe({ type: 'system', ...message })
      const evidence = decoder.drain(++clock)
      const before = store.getSnapshot().revision
      reconcileAgentChildWorkEvidence({ store, admission, parent, provider: 'claude', evidence })
      const writes = store.getSnapshot().revision - before
      if (message.subtype === 'background_tasks_changed') {
        const live = evidence.filter((edge) => edge.type === 'live').length
        expect(live).toBeLessThanOrEqual(rosterBound)
        expect(writes).toBeLessThanOrEqual(rosterBound)
        rosterEdges += live
        rosterWrites += writes
      }
    }
    const owner = {
      task_id: 'owner',
      task_type: 'local_agent',
      tool_use_id: 'tool-owner',
      is_backgrounded: true
    }
    feed({ subtype: 'task_started', ...owner })
    let shellOwner = 'owner'
    const shell = (id: number) => ({
      task_id: `shell-${id}`,
      task_type: 'local_bash',
      description: `shell${id}`,
      parent_task_id: shellOwner
    })
    const live: number[] = []
    for (let id = 0; id < count; id++) {
      live.push(id)
      const roster = { subtype: 'background_tasks_changed', tasks: [owner, ...live.map(shell)] }
      // Only one task is newly present; unchanged replacement rosters need no host writes.
      feed(roster, 1)
      feed({
        subtype: 'task_started',
        ...shell(id),
        tool_use_id: `tool-${id}`,
        is_backgrounded: true
      })
      feed(roster)
    }
    // The introductions above need at most one edge/write each, independent of full-roster size.
    expect(rosterEdges).toBeLessThanOrEqual(count)
    expect(rosterWrites).toBeLessThanOrEqual(count)
    rosterEdges = 0
    rosterWrites = 0
    feed({ subtype: 'task_started', ...owner, task_id: 'owner-second', tool_use_id: 'tool-second' })
    shellOwner = 'owner-second'
    // A real owner change invalidates exactly the affected children, then its duplicate invalidates none.
    feed({ subtype: 'background_tasks_changed', tasks: live.map(shell) }, count)
    feed({ subtype: 'background_tasks_changed', tasks: live.map(shell) })
    for (let id = 0; id < count; id++) {
      feed({
        subtype: 'task_notification',
        task_id: `shell-${id}`,
        tool_use_id: `tool-${id}`,
        status: 'completed'
      })
      live.shift()
      feed({ subtype: 'background_tasks_changed', tasks: [owner, ...live.map(shell)] })
    }
    // N introductions require at most N live edges and N store writes, independent of roster size.
    expect(rosterEdges).toBeLessThanOrEqual(count)
    expect(rosterWrites).toBeLessThanOrEqual(count)
    expect(store.getChildren(parent).filter((child) => child.kind === 'command')).toHaveLength(
      count
    )
  }
})
