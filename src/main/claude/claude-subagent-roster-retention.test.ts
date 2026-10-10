import { describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { isSubagentGroupBlock } from '../../shared/native-chat-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ClaudeSubagentRoster } from './claude-subagent-roster'
import type { ClaudeJournaledRosterSource } from './claude-subagent-journaled-roster'

function harness(journaled?: ClaudeJournaledRosterSource) {
  const rows = new Map<string, AgentJournalItemBody>()
  let group = 'oldest'
  let writes = 0
  let refuseAppend = false
  let refusePublish = false
  const append = (identity: AgentJournalItemIdentity, body: AgentJournalItemBody): void => {
    if (identity.provider !== 'orca') {
      throw new Error('unexpected roster identity')
    }
    rows.set(identity.clientMessageId, body)
    writes++
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: append,
    appendTombstone: () => {},
    publish: () => {},
    tryAppendItem: (identity, body) => {
      if (refuseAppend) {
        return { accepted: false, reason: 'backpressure' }
      }
      append(identity, body)
      return { accepted: true }
    },
    tryPublish: () =>
      refusePublish ? { accepted: false, reason: 'backpressure' } : { accepted: true }
  }
  const roster = new ClaudeSubagentRoster({
    sink,
    journaled,
    currentGroupKey: () => group,
    currentTurnScope: () => AGENT_JOURNAL_THREAD_SCOPE
  })
  const start = (id: string, tool = id, backgrounded = false): void => {
    roster.observeSystemFrame({
      type: 'system',
      subtype: 'task_started',
      task_type: 'local_agent',
      task_id: id,
      tool_use_id: tool,
      description: id,
      is_backgrounded: backgrounded
    })
  }
  const finish = (id: string, tool = id): void => {
    roster.observeSystemFrame({
      type: 'system',
      subtype: 'task_notification',
      task_id: id,
      tool_use_id: tool,
      status: 'completed'
    })
  }
  const agents = (key: string) => {
    const body = rows.get(`claude-subagents:${key}`)
    return body?.kind === 'message' ? (body.blocks.find(isSubagentGroupBlock)?.agents ?? []) : []
  }
  const churn = (count: number, settled = true): void => {
    for (let index = 0; index < count; index++) {
      group = `later-${index}`
      start(`later-child-${index}`)
      if (settled) {
        finish(`later-child-${index}`)
      }
    }
  }
  return {
    roster,
    start,
    finish,
    agents,
    churn,
    writes: () => writes,
    setGroup: (key: string) => {
      group = key
    },
    refuse: (append: boolean, publish: boolean) => {
      refuseAppend = append
      refusePublish = publish
    }
  }
}

describe('Claude shared settled-only roster retention', () => {
  it('keeps every child of the oldest live group past 33 later spawn groups', () => {
    const h = harness()
    h.start('a', 'tool-a', true)
    h.start('b', 'tool-b', true)
    h.roster.settleTurn('oldest')
    h.churn(34)
    expect(h.agents('oldest').map((entry) => entry.state)).toEqual(['working', 'working'])
    h.finish('a', 'tool-a')
    expect(h.agents('oldest').map((entry) => entry.state)).toEqual(['completed', 'working'])
    h.finish('b', 'tool-b')
    expect(h.agents('oldest').map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(h.agents('oldest').map((entry) => entry.state)).toEqual(['completed', 'completed'])
  })

  it('reaches every still-running group in the session-end sweep', () => {
    const h = harness()
    h.start('a', 'tool-a', true)
    h.start('b')
    h.churn(34, false)
    h.roster.settleSession()
    expect(h.agents('oldest').map((entry) => entry.state)).toEqual(['unverifiable', 'unverifiable'])
    expect(h.agents('later-33')[0].state).toBe('unverifiable')
  })

  it('ignores old announcements after settled eviction and alias-cache churn, but admits a new invocation', () => {
    const h = harness()
    h.start('a', 'first')
    h.finish('a', 'first')
    h.start('a', 'second')
    h.finish('a', 'second')
    h.churn(600)
    const before = h.writes()
    h.start('a', 'first')
    h.start('a', 'second')
    h.roster.observeSystemFrame({
      type: 'system',
      subtype: 'task_started',
      task_type: 'local_agent',
      task_id: 'a'
    })
    h.roster.observeChildActivity('first')
    expect(h.writes()).toBe(before)
    expect(h.roster.linkage.settledLinkageFor('first').linkage.agentId).toBe('a')
    h.setGroup('resumed')
    h.start('a', 'third')
    expect(h.agents('resumed')).toEqual([expect.objectContaining({ id: 'a', state: 'working' })])
  })

  it('keeps an inherited row reachable when child traffic precedes its resume announcement', () => {
    let claimed = false
    const h = harness({
      canonical: (tool) => (tool === 'original-spawn' ? 'a' : null),
      groupOf: (id) => (['a', 'b'].includes(id) ? 'inherited' : null),
      claimGroup: (group) => {
        if (group !== 'inherited' || claimed) {
          return null
        }
        claimed = true
        return {
          entries: ['a', 'b'].map((id) => ({
            id,
            label: id,
            state: 'completed',
            startedAt: 1,
            settledAt: 2
          })),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      },
      attempt: () => 4
    })
    h.churn(32, false)
    h.roster.observeChildActivity('original-spawn')
    h.setGroup('resumed')
    h.start('a', 'resume-tool', true)
    expect(h.agents('inherited').map((entry) => entry.state)).toEqual(['working', 'completed'])
    expect(h.agents('resumed')).toHaveLength(0)
    expect(h.roster.linkage.settledLinkageFor('original-spawn').linkage).toMatchObject({
      agentId: 'a',
      attempt: 5
    })
  })

  for (const failure of ['append', 'publish']) {
    it(`retains a terminal group whose final ${failure} was refused and retries it`, () => {
      const h = harness()
      h.start('a')
      h.start('b')
      h.refuse(failure === 'append', failure === 'publish')
      h.finish('a')
      h.finish('b')
      h.refuse(false, false)
      h.churn(34)
      h.finish('b')
      expect(h.agents('oldest').map((entry) => entry.state)).toEqual(['completed', 'completed'])
      const before = h.writes()
      h.start('a')
      expect(h.writes()).toBe(before)
    })
  }
})
