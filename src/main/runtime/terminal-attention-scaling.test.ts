import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_DONE_QUIET_MS } from '../../shared/agent-transitions'
import { TerminalAgentPhonePush } from './terminal-agent-phone-push'
import { createHost, WT, terminalHostCleanups } from './terminal-phone-flow.test-fixture'
import {
  countAttentionCollectionWork,
  isAttentionReplay
} from './attention-operation-count.test-fixture'
import { attentionDeliveryTail } from './attention-delivery-tail.test-fixture'

vi.mock('../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
beforeEach(() => {
  vi.useFakeTimers({ now: 100_000, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  for (const cleanup of terminalHostCleanups.splice(0)) {
    cleanup()
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('keeps targeted sender reads constant at P=10/100 and disposes every owned quiet timer', () => {
  const results: {
    owners: number
    reads: number
    visits: number
    pending: number
    cancelled: number
    detachKeyVisits: number
  }[] = []
  for (const owners of [10, 100]) {
    const { server, report, alerts } = createHost()
    const panes = Array.from(
      { length: owners },
      (_, index) => `tab-${index}:11111111-1111-4111-8111-111111111111`
    )
    for (const pane of panes) {
      report('working', undefined, WT, pane)
    }
    expect(server.getStatusSnapshot()).toHaveLength(owners)
    expect(server.getStatusSnapshotForPane(panes[0]!)[0]?.state).toBe('working')
    // Test-only attribution depends on source-mapped filenames, with native path separators normalized.
    let reads = 0
    const read = server.getStatusSnapshotForPane.bind(server)
    vi.spyOn(server, 'getStatusSnapshotForPane').mockImplementation((key) => {
      if (
        new Error('Trace sender-owned work').stack
          ?.replaceAll('\\', '/')
          .match(/\/terminal-agent-(?:phone-push|turn-news)\.ts:/)
      ) {
        reads += 1
      }
      return read(key)
    })
    const observe = vi.spyOn(TerminalAgentPhonePush.prototype, 'observe')
    report('working', undefined, WT, panes[0])
    vi.advanceTimersByTime(1)
    report('done', undefined, WT, panes[0])
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(alerts.filter((event) => event.type === 'notification')).toHaveLength(1)
    expect(reads).toBeGreaterThan(0)
    expect(reads).toBeLessThanOrEqual(16)
    const targetedReads = reads
    const visits = observe.mock.calls.length
    expect(visits).toBeGreaterThan(0)
    expect(visits).toBeLessThanOrEqual(8)
    observe.mockRestore()
    const ownedTimers = new Set<ReturnType<typeof setTimeout>>()
    const schedule = globalThis.setTimeout
    const schedules = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, delay, ...args) => {
        const timer = schedule(callback, delay, ...args)
        if (
          new Error('Trace sender-owned work').stack
            ?.replaceAll('\\', '/')
            .includes('/agent-completion-notification-controller.ts:')
        ) {
          ownedTimers.add(timer)
        }
        return timer
      })
    for (const pane of panes) {
      report('working', undefined, WT, pane)
      report('done', undefined, WT, pane)
    }
    schedules.mockRestore()
    const pending = ownedTimers.size
    expect(pending).toBe(owners)
    const cancelTimer = globalThis.clearTimeout
    let cancelled = 0
    const cancel = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((timer) => {
      if (typeof timer === 'object' && timer !== null && ownedTimers.delete(timer)) {
        cancelled += 1
      }
      cancelTimer(timer)
    })
    const disposal = countAttentionCollectionWork(() => {
      for (const cleanup of terminalHostCleanups.splice(0)) {
        cleanup()
      }
    })
    // Whole-detach Map-key work includes every cleanup, not only sender contexts.
    expect(disposal.counts.mapKeys).toBeGreaterThan(0)
    expect(disposal.counts.mapKeys).toBeLessThanOrEqual(2 * owners)
    expect(cancelled).toBe(owners)
    expect(ownedTimers.size).toBe(0)
    const count = alerts.length
    report('working')
    report('waiting')
    vi.advanceTimersByTime(AGENT_DONE_QUIET_MS)
    expect(alerts).toHaveLength(count)
    results.push({
      owners,
      reads: targetedReads,
      visits,
      pending,
      cancelled,
      detachKeyVisits: disposal.counts.mapKeys
    })
    cancel.mockRestore()
  }
  expect(results[1]!.reads).toBe(results[0]!.reads)
  expect(results[1]!.visits).toBe(results[0]!.visits)
  console.info('terminal-owner-scaling', results)
})

it.each([
  [20, 2],
  [200, 2],
  [200, 20]
])(
  'retires generic replay R=%i K/Q=%i through a genuine same-source hook start',
  async (replay, count) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-pr30900-terminal-perf-'))
    const { runtime, server, report } = createHost()
    const controller = runtime.controller
    const tail = attentionDeliveryTail(controller, directory)
    let proved = true
    let start = Date.now()
    const read = server.getStatusSnapshotForPane.bind(server)
    vi.spyOn(server, 'getStatusSnapshotForPane').mockImplementation((key) =>
      read(key).map((row) =>
        proved
          ? {
              ...row,
              terminalHandle: 'positive-fixture-terminal',
              runId: 'positive-fixture-run',
              executionId: 'positive-fixture-execution',
              turnStartedAt: start
            }
          : row
      )
    )
    try {
      report('working')
      for (let index = 0; index < replay - count; index += 1) {
        controller.dispatch({
          type: 'notification',
          source: 'test',
          title: '',
          body: '',
          notificationId: `background-${index}`
        })
      }
      const records = vi.spyOn(controller.announcedNotifications, 'record')
      const recordCopies: number[] = []
      for (let index = 0; index < count; index += 1) {
        vi.advanceTimersByTime(6_000)
        report('working')
        const record = countAttentionCollectionWork(
          () => report('waiting'),
          (values) => {
            const first = values[0]
            return !!first && typeof first === 'object' && 'alert' in first && 'source' in first
          }
        )
        expect(record.counts.copies).toBeGreaterThan(0)
        expect(record.counts.copies).toBeLessThanOrEqual(3 * (index + 1))
        recordCopies.push(record.counts.copies)
      }
      expect(records).toHaveBeenCalledTimes(count)
      const selected = tail.events.filter(
        (event) => event.type === 'notification' && event.source === 'agent-task-complete'
      )
      expect(selected).toHaveLength(count)
      expect(controller.getMissedSince(0)).toHaveLength(replay)
      const before = tail.mark()
      start = Date.now() + 10
      vi.advanceTimersByTime(10)
      const helper = countAttentionCollectionWork(
        () => report('working'),
        (values) => {
          const first = values[0]
          return (
            isAttentionReplay(values) ||
            (!!first && typeof first === 'object' && 'alert' in first && 'source' in first)
          )
        }
      )
      const matching = helper.counts.replayCallbacks
      const helperFilters = helper.counts.filter - helper.counts.replayFilters
      expect(helperFilters).toBeGreaterThan(0)
      expect(helperFilters).toBeLessThanOrEqual(2 * count)
      expect(helper.counts.map).toBe(count)
      expect(helper.counts.membership).toBeGreaterThan(0)
      expect(helper.counts.membership).toBeLessThanOrEqual(count * count)
      expect(matching).toBeGreaterThan(0)
      expect(matching).toBeLessThanOrEqual(replay + 2 * count * replay)
      const downstream = await tail.assertRetired(before, selected)
      proved = false
      vi.advanceTimersByTime(6_000)
      report('waiting')
      expect(tail.events.at(-1)).toMatchObject({ type: 'notification', agentState: 'waiting' })
      const missing = tail.mark()
      vi.advanceTimersByTime(6_000)
      report('working')
      expect(tail.mark().event).toBe(missing.event)
      console.info('generic-retirement-scaling', {
        replay,
        count,
        helper: helper.counts,
        recordCopies,
        matching,
        downstream
      })
    } finally {
      await tail.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
