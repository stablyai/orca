import { describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import type { NativeChatSubagentEntry } from '../../shared/native-chat-types'
import type { JournaledClaudeSubagentGroup } from './claude-subagent-group-row'
import type { ClaudeJournaledRosterSource } from './claude-subagent-journaled-roster'
import { ClaudeSubagentRosterGroups } from './claude-subagent-roster-groups'

const entry = (id: string): NativeChatSubagentEntry => ({
  id,
  label: `Child ${id}`,
  state: 'unverifiable',
  startedAt: 1,
  settledAt: 2
})

const turnScope = (groupId: string): AgentJournalTurnScope => ({
  kind: 'turn',
  turnItemId: `claude:claude-session:${groupId}`
})

/** An older build listed `agent-a` in both rows; the reading places it in the later one. */
function journaledTwiceListed(): ClaudeJournaledRosterSource {
  const rows = new Map<string, JournaledClaudeSubagentGroup>([
    ['turn-a', { entries: [entry('agent-a'), entry('agent-b')], turnScope: turnScope('turn-a') }],
    ['turn-b', { entries: [entry('agent-a')], turnScope: turnScope('turn-b') }]
  ])
  const groupOf = new Map([
    ['agent-a', 'turn-b'],
    ['agent-b', 'turn-a']
  ])
  return {
    canonical: () => null,
    groupOf: (id) => groupOf.get(id) ?? null,
    claimGroup: (groupId) => {
      const row = rows.get(groupId) ?? null
      rows.delete(groupId)
      return row
    },
    attempt: () => 1
  }
}

describe('ClaudeSubagentRosterGroups', () => {
  it('places a twice-listed child where the reading does, whichever row is reached first', () => {
    for (const order of [
      ['agent-a', 'agent-b'],
      ['agent-b', 'agent-a']
    ]) {
      const groups = new ClaudeSubagentRosterGroups({
        journaled: journaledTwiceListed(),
        currentTurnScope: () => AGENT_JOURNAL_THREAD_SCOPE,
        onEvicted: () => {}
      })
      for (const id of order) {
        groups.locateOrInherit(id)
      }
      expect(groups.locate('agent-a')?.group.groupId).toBe('turn-b')
      expect(groups.locate('agent-b')?.group.groupId).toBe('turn-a')
    }
  })

  it('keeps a child placed in a held row when another row listing it is evicted', () => {
    const groups = new ClaudeSubagentRosterGroups({
      journaled: journaledTwiceListed(),
      currentTurnScope: () => AGENT_JOURNAL_THREAD_SCOPE,
      onEvicted: () => {}
    })
    groups.locateOrInherit('agent-b')
    groups.locateOrInherit('agent-a')
    // Enough of this run's own rows to push the older inherited row out.
    for (let turn = 0; turn < 31; turn += 1) {
      groups.groupFor(`turn-${turn}-new`)
    }
    expect(groups.get('turn-a')).toBeUndefined()
    expect(groups.locate('agent-b')).toBeNull()
    expect(groups.locate('agent-a')?.group.groupId).toBe('turn-b')
  })

  it('keeps an inherited row beside the turn that wrote it, and puts a new row beside the open turn', () => {
    const live = turnScope('turn-live')
    const groups = new ClaudeSubagentRosterGroups({
      journaled: journaledTwiceListed(),
      currentTurnScope: () => live,
      onEvicted: () => {}
    })
    expect(groups.locateOrInherit('agent-b')?.group.turnScope).toEqual(turnScope('turn-a'))
    expect(groups.groupFor('turn-live').turnScope).toEqual(live)
  })
})
