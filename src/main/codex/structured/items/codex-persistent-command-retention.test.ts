import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { CodexBackgroundCommandTracker } from '../background-work/codex-background-command-tracker'
import { CodexJournalItems } from '../journal/codex-structured-journal-items'
import { settleCodexJournalTurn } from '../journal/codex-structured-journal-settlement'

function command(threadId: string, id: string, method = 'item/started') {
  return {
    threadId,
    method,
    params: {
      turnId: 'turn',
      item: {
        type: 'commandExecution',
        id,
        source: 'unifiedExecStartup',
        command: `sleep 30 # ${threadId}/${id}`,
        cwd: '/workspace',
        status: method === 'item/completed' ? 'completed' : 'inProgress',
        ...(method === 'item/completed' ? { exitCode: 0, aggregatedOutput: 'BEFORE\nAFTER\n' } : {})
      }
    }
  }
}

function fixture() {
  const rows = new Map<string, AgentJournalItemBody>()
  const scheduled = new Set<() => void>()
  const sink = {
    appendItem: (
      identity: Parameters<typeof agentJournalItemKey>[0],
      body: AgentJournalItemBody
    ) => {
      rows.set(agentJournalItemKey(identity), body)
    },
    appendTombstone() {},
    publish() {}
  }
  const items = new CodexJournalItems(
    {
      sink,
      attributionFor: () => ({ turnScope: AGENT_JOURNAL_THREAD_SCOPE }),
      schedule: (run) => {
        scheduled.add(run)
        return () => {
          scheduled.delete(run)
        }
      }
    },
    () => 'turn',
    () => {}
  )
  return { items, sink, rows, scheduled }
}

describe('persistent command retention', () => {
  it('retains 448 live commands through completed turns, late output, and process completion', () => {
    const { items, sink, rows, scheduled } = fixture()
    const tracker = new CodexBackgroundCommandTracker('thread-0')
    const events = Array.from({ length: 7 }, (_, thread) =>
      Array.from({ length: 64 }, (_, index) => command(`thread-${thread}`, `exec-${index}`))
    ).flat()
    for (const event of events) {
      expect(items.handle(event)).toMatchObject({ admission: { accepted: true } })
      tracker.observe(event)
      expect(
        items.streams.handle(event.threadId, 'item/commandExecution/outputDelta', {
          turnId: 'turn',
          itemId: event.params.item.id,
          delta: 'BEFORE\n'
        }).admission
      ).toEqual({ accepted: true })
    }
    expect(tracker.tasks()).toEqual([])
    for (let thread = 0; thread < 7; thread += 1) {
      const threadId = `thread-${thread}`
      expect(tracker.threadCommands(threadId)).toHaveLength(64)
      expect(
        settleCodexJournalTurn({
          sessionId: 'session',
          threadId,
          turnId: 'turn',
          turnLifecycle: null,
          completedAt: 1,
          turnEnd: 'completed',
          sink,
          streams: items.streams,
          activeItems: items.activeItems,
          attributionFor: () => ({ turnScope: AGENT_JOURNAL_THREAD_SCOPE })
        })
      ).toEqual({ accepted: true })
      expect(tracker.endTurn(threadId, 'turn')).toHaveLength(64)
      expect(tracker.tasks()).toHaveLength((thread + 1) * 64)
    }
    expect(items.activeItems.size).toBe(448)
    expect(items.streams.persistentCount).toBe(448)
    expect(tracker.tasks()).toHaveLength(448)
    for (const event of events) {
      items.streams.handle(event.threadId, 'item/commandExecution/outputDelta', {
        turnId: 'turn',
        itemId: event.params.item.id,
        delta: 'AFTER\n'
      })
    }
    expect(items.streams.flush()).toBe(true)
    for (const event of events) {
      const key = agentJournalItemKey({
        provider: 'orca',
        clientMessageId: `codex-item:${event.threadId}:${event.params.item.id}`
      })
      expect(rows.get(key)).toMatchObject({
        state: 'running',
        input: { command: event.params.item.command, cwd: '/workspace' },
        output: { head: 'BEFORE\nAFTER\n' }
      })
      const completed = command(event.threadId, event.params.item.id, 'item/completed')
      expect(items.handle(completed)).toMatchObject({ admission: { accepted: true } })
      tracker.observe(completed)
      expect(rows.get(key)).toMatchObject({
        state: 'completed',
        output: { head: 'BEFORE\nAFTER\n' }
      })
      expect(items.streams.snapshot(event.threadId, event.params.item.id)).toBeNull()
    }
    expect(items.activeItems.size).toBe(0)
    expect(items.streams.persistentCount).toBe(0)
    expect(tracker.tasks()).toEqual([])
    items.dispose()
    expect(scheduled.size).toBe(0)
  })
})
