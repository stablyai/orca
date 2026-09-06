import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock
} from '../../shared/native-chat-types'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeSubagentRoster } from './claude-subagent-roster'

const TURN_1 = 'claude-session:turn-1'

function agentsOf(body: AgentJournalItemBody | undefined): NativeChatSubagentEntry[] {
  if (!body || body.kind !== 'message') {
    return []
  }
  const block = body.blocks.find(
    (candidate): candidate is NativeChatSubagentGroupBlock => candidate.type === 'subagent-group'
  )
  return block ? block.agents : []
}

function isGroupRow(identity: AgentJournalItemIdentity, groupId: string): boolean {
  return identity.provider === 'orca' && identity.clientMessageId === `claude-subagents:${groupId}`
}

function harness(groupKey: string | null = TURN_1) {
  const items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[] = []
  const tombstones: AgentJournalItemIdentity[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => items.push({ identity, body }),
    appendTombstone: (identity) => tombstones.push(identity),
    publish: vi.fn()
  }
  let clock = 1_000
  let key = groupKey
  const roster = new ClaudeSubagentRoster({
    sink,
    currentGroupKey: () => key,
    now: () => (clock += 1)
  })
  const roles = (): NativeChatSubagentEntry[] => agentsOf(items.at(-1)?.body)
  /** The last row written for one group, so a test can read a row that is no
   *  longer the newest one. */
  const rolesIn = (groupId: string): NativeChatSubagentEntry[] =>
    agentsOf(items.findLast((item) => isGroupRow(item.identity, groupId))?.body)
  return {
    roster,
    items,
    tombstones,
    roles,
    rolesIn,
    setGroupKey: (next: string | null) => {
      key = next
    }
  }
}

function system(subtype: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'system', subtype, session_id: 'claude-session', ...fields }
}

function started(fields: Record<string, unknown>): Record<string, unknown> {
  return system('task_started', { task_type: 'local_agent', ...fields })
}

describe('ClaudeSubagentRoster', () => {
  it('builds the row from task_started, with the fallback sentence beside the block', () => {
    const { roster, items, roles } = harness()
    roster.observeSystemFrame(
      started({ task_id: 'task-1', tool_use_id: 'toolu_1', description: 'Review the diff' })
    )
    expect(items).toHaveLength(1)
    expect(items[0]?.identity).toEqual({
      provider: 'orca',
      clientMessageId: 'claude-subagents:claude-session:turn-1'
    })
    const body = items[0]?.body
    expect(body?.kind === 'message' && body.blocks[0]).toEqual({
      type: 'text',
      text: 'Kicked off 1 subagent — 1 working'
    })
    expect(roles()).toEqual([
      expect.objectContaining({ id: 'task-1', label: 'Review the diff', state: 'working' })
    ])
  })

  it('keeps a backgrounded shell task out of the roster', () => {
    const { roster, items } = harness()
    roster.observeSystemFrame(
      system('task_started', {
        task_id: 'task-bash',
        tool_use_id: 'toolu_bash',
        task_type: 'local_bash',
        description: 'sleep 20',
        is_backgrounded: true
      })
    )
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-bash', patch: { status: 'running' } })
    )
    // Its own frames carry a tool_use_id, so only the excluded-id memory stops it.
    roster.observeChildActivity('toolu_bash')
    expect(items).toHaveLength(0)
  })

  it('never renders a task marked skip_transcript', () => {
    const { roster, items } = harness()
    roster.observeSystemFrame(
      started({ task_id: 'task-a', tool_use_id: 'toolu_a', skip_transcript: true })
    )
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-a', patch: { status: 'completed' } })
    )
    roster.observeChildActivity('toolu_a')
    expect(items).toHaveLength(0)
  })

  it('drops a provisional row once an announcement says the task is not a subagent', () => {
    const { roster, items, tombstones, roles } = harness()
    roster.observeChildActivity('toolu_bash')
    expect(roles()).toHaveLength(1)
    roster.observeSystemFrame(
      system('task_started', {
        task_id: 'task-bash',
        tool_use_id: 'toolu_bash',
        task_type: 'local_bash'
      })
    )
    expect(tombstones).toEqual([
      { provider: 'orca', clientMessageId: 'claude-subagents:claude-session:turn-1' }
    ])
    expect(items).toHaveLength(1)
  })

  it('does not duplicate a resumed task re-announced under a new tool_use_id', () => {
    const { roster, roles } = harness()
    roster.observeSystemFrame(
      started({ task_id: 'task-1', tool_use_id: 'toolu_first', description: 'Audit' })
    )
    roster.observeChildActivity('toolu_first')
    roster.observeSystemFrame(
      started({ task_id: 'task-1', tool_use_id: 'toolu_second', description: 'Audit' })
    )
    roster.observeChildActivity('toolu_second')
    expect(roles()).toEqual([
      expect.objectContaining({ id: 'task-1', label: 'Audit', state: 'working' })
    ])
  })

  it('adopts a row built from child traffic when the announcement finally names it', () => {
    const { roster, roles } = harness()
    roster.observeChildActivity('toolu_1')
    expect(roles()).toEqual([expect.objectContaining({ id: 'toolu_1', label: 'subagent' })])
    roster.observeSystemFrame(
      started({ task_id: 'task-1', tool_use_id: 'toolu_1', description: 'Explore' })
    )
    expect(roles()).toEqual([
      expect.objectContaining({ id: 'task-1', label: 'Explore', state: 'working' })
    ])
  })

  it('is idempotent: a repeated frame writes no new revision', () => {
    const { roster, items } = harness()
    const frame = started({ task_id: 'task-1', tool_use_id: 'toolu_1', description: 'Audit' })
    roster.observeSystemFrame(frame)
    roster.observeSystemFrame(frame)
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-1', patch: { status: 'running' } })
    )
    expect(items).toHaveLength(1)
  })

  it('latches a terminal state against a later live report', () => {
    const { roster, roles } = harness()
    roster.observeSystemFrame(started({ task_id: 'task-1', description: 'Audit' }))
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-1', patch: { status: 'failed' } })
    )
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-1', patch: { status: 'running' } })
    )
    expect(roles()).toEqual([expect.objectContaining({ state: 'failed' })])
  })

  it('ignores an update for a task it never rostered', () => {
    const { roster, items } = harness()
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-unknown', patch: { status: 'running' } })
    )
    expect(items).toHaveLength(0)
  })

  it('disambiguates children that share a description', () => {
    const { roster, roles } = harness()
    roster.observeSystemFrame(started({ task_id: 'task-1', description: 'Explore' }))
    roster.observeSystemFrame(started({ task_id: 'task-2', description: 'Explore' }))
    expect(roles().map((agent) => agent.label)).toEqual(['Explore', 'Explore 2'])
  })

  describe('turn end', () => {
    it('leaves a backgrounded child working and marks a foreground one unverifiable', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(started({ task_id: 'task-fg', description: 'Foreground' }))
      roster.observeSystemFrame(
        started({ task_id: 'task-bg', description: 'Background', is_backgrounded: true })
      )
      roster.settleTurn(TURN_1)
      expect(roles()).toEqual([
        expect.objectContaining({ label: 'Foreground', state: 'unverifiable' }),
        expect.objectContaining({ label: 'Background', state: 'working' })
      ])
    })

    it('never re-settles a child that already reported an outcome', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(started({ task_id: 'task-1', description: 'Audit' }))
      roster.observeSystemFrame(
        system('task_updated', { task_id: 'task-1', patch: { status: 'completed' } })
      )
      roster.settleTurn(TURN_1)
      expect(roles()).toEqual([expect.objectContaining({ state: 'completed' })])
    })

    it('sweeps backgrounded children only when the provider itself is gone', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(
        started({ task_id: 'task-bg', description: 'Background', is_backgrounded: true })
      )
      roster.settleTurn(TURN_1)
      roster.settleSession()
      expect(roles()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
    })
  })

  describe('spawn tool result', () => {
    it('settles a foreground child', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(started({ task_id: 'task-1', tool_use_id: 'toolu_1' }))
      roster.observeToolResult('toolu_1', false)
      expect(roles()).toEqual([expect.objectContaining({ state: 'completed' })])
    })

    it('reports a failed spawn as failed', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(started({ task_id: 'task-1', tool_use_id: 'toolu_1' }))
      roster.observeToolResult('toolu_1', true)
      expect(roles()).toEqual([expect.objectContaining({ state: 'failed' })])
    })

    it('ignores the immediate result a backgrounded spawn returns', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(
        started({ task_id: 'task-1', tool_use_id: 'toolu_1', is_backgrounded: true })
      )
      roster.observeToolResult('toolu_1', false)
      expect(roles()).toEqual([expect.objectContaining({ state: 'working' })])
    })

    it('ignores results for tools that are not spawn calls', () => {
      const { roster, items } = harness()
      roster.observeToolResult('toolu_read', false)
      expect(items).toHaveLength(0)
    })
  })

  describe('label ordinals', () => {
    it('never re-issues an ordinal a removed row gave up', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(started({ task_id: 'task-1', description: 'Audit' }))
      roster.observeSystemFrame(started({ task_id: 'task-2', description: 'Audit' }))
      // task-1 is re-announced as a shell task, so its row goes; reclaiming the
      // ordinal it held would print a second 'Audit 2' beside the one still shown.
      roster.observeSystemFrame(
        system('task_started', { task_id: 'task-1', task_type: 'local_bash' })
      )
      roster.observeSystemFrame(started({ task_id: 'task-3', description: 'Audit' }))
      expect(roles().map((agent) => agent.label)).toEqual(['Audit 2', 'Audit 3'])
    })

    it('never generates a label a provider-supplied one already took', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(started({ task_id: 'task-1', description: 'Audit' }))
      roster.observeSystemFrame(started({ task_id: 'task-2', description: 'Audit' }))
      // The provider's own name for the third child is the label the ordinal just
      // generated for the second; a per-base counter would print it twice.
      roster.observeSystemFrame(started({ task_id: 'task-3', description: 'Audit 2' }))
      const labels = roles().map((agent) => agent.label)
      expect(labels).toEqual(['Audit', 'Audit 2', 'Audit 2 2'])
      expect(new Set(labels).size).toBe(labels.length)
    })
  })

  describe('child traffic for an id the CLI never declared', () => {
    it('creates nothing once the CLI has announced any task at all', () => {
      const { roster, items } = harness()
      // A rejected announcement still proves this CLI declares what it spawns.
      roster.observeSystemFrame(
        system('task_started', { task_id: 'task-bash', task_type: 'local_bash' })
      )
      roster.observeChildActivity('toolu_never_announced')
      expect(items).toHaveLength(0)
    })

    it('rejects an over-long provisional id instead of storing it as an entry id', () => {
      const { roster, items } = harness()
      // The announced path drops an id past `claudeTaskId`'s bound; the
      // provisional one writes the same durable entry id, so it must too.
      roster.observeChildActivity(`toolu_${'x'.repeat(512)}`)
      expect(items).toHaveLength(0)
      roster.observeChildActivity(`toolu_${'x'.repeat(500)}`)
      expect(items).toHaveLength(1)
    })

    it('still rosters a subagent announced after a task the filter rejected', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(
        system('task_started', { task_id: 'task-bash', task_type: 'local_bash' })
      )
      // The gate closes the child-traffic fallback, never the announcement path.
      roster.observeSystemFrame(
        started({ task_id: 'task-1', tool_use_id: 'toolu_1', description: 'Explore' })
      )
      roster.observeChildActivity('toolu_1')
      expect(roles()).toEqual([
        expect.objectContaining({ id: 'task-1', label: 'Explore', state: 'working' })
      ])
    })

    it('leaves a grandchild parented inside the sidechain out of the roster', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(
        started({ task_id: 'task-1', tool_use_id: 'toolu_1', description: 'Explore' })
      )
      roster.observeChildActivity('toolu_1')
      // A tool the subagent itself ran: never announced, so never excluded either.
      roster.observeChildActivity('toolu_inner')
      expect(roles()).toEqual([
        expect.objectContaining({ id: 'task-1', label: 'Explore', state: 'working' })
      ])
    })

    it('still mints the provisional row for a release that announces no task', () => {
      const { roster, roles } = harness()
      roster.observeChildActivity('toolu_1')
      // Not an announcement: the fallback path stays open for this release.
      roster.observeSystemFrame(
        system('task_updated', { task_id: 'task-x', patch: { status: 'running' } })
      )
      roster.observeChildActivity('toolu_2')
      expect(roles().map((agent) => agent.label)).toEqual(['subagent', 'subagent 2'])
    })
  })

  describe('groups that no later event can reach', () => {
    it('loses contact with a group evicted past the bound', () => {
      const { roster, rolesIn, setGroupKey } = harness('turn-0')
      for (let index = 0; index < 33; index += 1) {
        setGroupKey(`turn-${index}`)
        roster.observeSystemFrame(started({ task_id: `task-${index}`, description: 'Audit' }))
      }
      expect(rolesIn('turn-0')).toEqual([expect.objectContaining({ state: 'unverifiable' })])
      expect(rolesIn('turn-32')).toEqual([expect.objectContaining({ state: 'working' })])
    })

    it('loses contact with a live child when the translator is disposed without an end', () => {
      const { roster, roles } = harness()
      roster.observeSystemFrame(
        started({ task_id: 'task-bg', description: 'Background', is_backgrounded: true })
      )
      roster.dispose()
      expect(roles()).toEqual([expect.objectContaining({ state: 'unverifiable' })])
    })

    it('writes nothing on dispose when the session already settled', () => {
      const { roster, items } = harness()
      roster.observeSystemFrame(started({ task_id: 'task-1', description: 'Audit' }))
      roster.settleSession()
      const written = items.length
      roster.dispose()
      expect(items).toHaveLength(written)
    })
  })

  it('groups children outside any turn under their own row', () => {
    const { roster, items } = harness(null)
    roster.observeSystemFrame(started({ task_id: 'task-1', description: 'Audit' }))
    expect(items[0]?.identity).toEqual({
      provider: 'orca',
      clientMessageId: 'claude-subagents:outside-turn'
    })
  })
})

describe('ClaudeSubagentRoster — the turn that is ending', () => {
  it('leaves a child announced outside any turn alone when an unrelated turn ends', () => {
    const { roster, rolesIn, setGroupKey } = harness(null)
    roster.observeSystemFrame(started({ task_id: 'task-early', description: 'Early' }))
    setGroupKey(TURN_1)
    roster.observeSystemFrame(started({ task_id: 'task-turn', description: 'In turn' }))
    roster.settleTurn(TURN_1)
    expect(rolesIn('outside-turn')).toEqual([expect.objectContaining({ state: 'working' })])
    expect(rolesIn(TURN_1)).toEqual([expect.objectContaining({ state: 'unverifiable' })])
    // `unverifiable` latches, so sweeping it above would have swallowed this.
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-early', patch: { status: 'completed' } })
    )
    expect(rolesIn('outside-turn')).toEqual([expect.objectContaining({ state: 'completed' })])
  })

  it('sweeps the outside-turn group when a turn with no key of its own ends', () => {
    const { roster, rolesIn } = harness(null)
    roster.observeSystemFrame(started({ task_id: 'task-early', description: 'Early' }))
    roster.settleTurn(null)
    expect(rolesIn('outside-turn')).toEqual([expect.objectContaining({ state: 'unverifiable' })])
  })

  it('still settles an outside-turn child once the session itself ends', () => {
    const { roster, rolesIn, setGroupKey } = harness(null)
    roster.observeSystemFrame(started({ task_id: 'task-early', description: 'Early' }))
    setGroupKey(TURN_1)
    roster.observeSystemFrame(started({ task_id: 'task-turn', description: 'In turn' }))
    roster.settleTurn(TURN_1)
    roster.settleSession()
    expect(rolesIn('outside-turn')).toEqual([expect.objectContaining({ state: 'unverifiable' })])
  })

  it('sweeps the turn that ended, not whichever turn is live now', () => {
    const { roster, rolesIn, setGroupKey } = harness()
    roster.observeSystemFrame(started({ task_id: 'task-1', description: 'First turn' }))
    setGroupKey('claude-session:turn-2')
    roster.observeSystemFrame(started({ task_id: 'task-2', description: 'Second turn' }))
    // Turn 1's result lands after turn 2 has already begun.
    roster.settleTurn(TURN_1)
    expect(rolesIn(TURN_1)).toEqual([expect.objectContaining({ state: 'unverifiable' })])
    expect(rolesIn('claude-session:turn-2')).toEqual([
      expect.objectContaining({ state: 'working' })
    ])
  })
})

describe('ClaudeSubagentRoster — through the real sink queue', () => {
  it('lands every revision, not just the one that was already in flight', async () => {
    const appended: AgentJournalItemBody[] = []
    let published = 0
    const journal = {
      appendItem: async (_identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
        appended.push(body)
        return { cursor: { epoch: 'e', sequence: appended.length } }
      },
      appendTombstone: async () => ({ epoch: 'e', sequence: 0 })
    } as unknown as AgentSessionJournal
    const deferred = createDeferredStructuredAgentSessionEventSink()
    deferred.bind({
      journal,
      fence: 1,
      publish: () => {
        published += 1
      }
    })
    const roster = new ClaudeSubagentRoster({ sink: deferred.sink, currentGroupKey: () => TURN_1 })

    // The first append is in flight while the rest are submitted, so a publish
    // sharing the row's coalescing key would evict them.
    roster.observeSystemFrame(started({ task_id: 'task-1', description: 'One' }))
    roster.observeSystemFrame(started({ task_id: 'task-2', description: 'Two' }))
    roster.observeSystemFrame(
      system('task_updated', { task_id: 'task-1', patch: { status: 'completed' } })
    )
    const drained = await deferred.drained()

    expect(drained).toEqual({ ok: true })
    expect(agentsOf(appended.at(-1))).toEqual([
      expect.objectContaining({ id: 'task-1', label: 'One', state: 'completed' }),
      expect.objectContaining({ id: 'task-2', label: 'Two', state: 'working' })
    ])
    expect(published).toBeGreaterThan(0)
  })
})
