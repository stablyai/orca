import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { CodexBackgroundCommandTracker } from './codex-background-command-tracker'
import {
  CodexItemStreamRetention,
  MAX_CODEX_ITEM_STREAM_METADATA_BYTES
} from './codex-item-stream-retention'
import { CodexJournalItems } from './codex-structured-journal-items'
import { settleCodexJournalTurn } from './codex-structured-journal-settlement'

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

function fixture(maxMetadataBytes?: number) {
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
      maxMetadataBytes,
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
  it('does not rebuild unchanged persistent output on every later lifecycle flush', () => {
    const { items } = fixture()
    const event = command('root', 'quiet')
    items.handle(event)
    items.streams.handle('root', 'item/commandExecution/outputDelta', {
      itemId: 'quiet',
      delta: 'retained-prefix'
    })
    items.streams.flush()
    const originalJoin = Array.prototype.join
    let retainedJoins = 0
    const spy = vi
      .spyOn(Array.prototype, 'join')
      .mockImplementation(function (this: unknown[], separator) {
        if (this[0] === 'retained-prefix') {
          retainedJoins += 1
        }
        return originalJoin.call(this, separator)
      })
    try {
      for (let index = 0; index < 100; index += 1) {
        items.streams.flush()
      }
    } finally {
      spy.mockRestore()
      items.dispose()
    }
    expect(retainedJoins).toBe(0)
  })

  it('retains 448 live commands through completed turns, late output, and process completion', () => {
    const { items, sink, rows, scheduled } = fixture()
    const tracker = new CodexBackgroundCommandTracker('thread-0')
    const events = Array.from({ length: 7 }, (_, thread) =>
      Array.from({ length: 64 }, (_, index) => command(`thread-${thread}`, `exec-${index}`))
    ).flat()
    for (const event of events) {
      expect(tracker.canObserve(event)).toBe(true)
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
    for (let thread = 0; thread < 7; thread += 1) {
      expect(
        settleCodexJournalTurn({
          sessionId: 'session',
          threadId: `thread-${thread}`,
          turnId: 'turn',
          sink,
          streams: items.streams,
          activeItems: items.activeItems
        })
      ).toEqual({ accepted: true })
    }
    expect(items.activeItems.size).toBe(448)
    expect(items.streams.persistentCount).toBe(448)
    expect(tracker.tasks()).toHaveLength(448)
    expect(tracker.retainedMetadataBytes).toBeLessThan(256 * 1024)
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
    expect(tracker.retainedMetadataBytes).toBeLessThan(64 * 1024)
    items.dispose()
    tracker.clear()
    expect(tracker.retainedMetadataBytes).toBe(0)
    expect(scheduled.size).toBe(0)
  })

  it('rejects command metadata exhaustion before appending or evicting live state and frees it on completion', () => {
    const { items, rows } = fixture(800)
    const first = command('root', 'first')
    const second = command('root', 'second')
    expect(items.handle(first)).toMatchObject({ admission: { accepted: true } })
    const prior = [...rows]
    expect(items.handle(second)).toMatchObject({ admission: { accepted: false, reason: 'failed' } })
    expect([...rows]).toEqual(prior)
    expect(items.activeItems.size).toBe(1)
    expect(items.handle(command('root', 'first', 'item/completed'))).toMatchObject({
      admission: { accepted: true }
    })
    expect(items.handle(second)).toMatchObject({ admission: { accepted: true } })
    items.dispose()
  })

  it('accounts metadata bytes instead of interpreting the item count as liveness', () => {
    const retention = new CodexItemStreamRetention()
    for (let index = 0; index < 448; index += 1) {
      const item = command('root', `exec-${index}`).params.item
      expect(
        retention.retain(item.id, {
          item,
          identity: { provider: 'orca', clientMessageId: item.id }
        })
      ).toBe(true)
    }
    expect(retention.size).toBe(448)
    expect(retention.retainedBytes).toBeLessThan(256 * 1024)
    expect(retention.retainedBytes).toBeLessThan(MAX_CODEX_ITEM_STREAM_METADATA_BYTES)
    expect(retention.overCapacity).toBe(false)
    expect(retention.oldestEvictable()).toBeUndefined()
    retention.clear()
    expect(retention.retainedBytes).toBe(0)
    expect(retention.persistentSize).toBe(0)
  })

  it('retains startup provenance when large command metadata is bounded', () => {
    const { items, sink } = fixture()
    const event = command('root', 'large')
    event.params.item.command = 'x'.repeat(128 * 1024)
    expect(items.handle(event)).toMatchObject({ admission: { accepted: true } })
    expect(
      settleCodexJournalTurn({
        sessionId: 'session',
        threadId: 'root',
        turnId: 'turn',
        sink,
        streams: items.streams,
        activeItems: items.activeItems
      })
    ).toEqual({ accepted: true })
    expect(items.activeItems.size).toBe(1)
    expect(items.streams.persistentCount).toBe(1)
    items.dispose()
  })
})
