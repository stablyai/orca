import { expect, vi } from 'vitest'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'

const inputWorkSamples = new Map<string, Record<string, number>>()
export function measureCodexInputWork(
  host: StructuredAgentSessionHost,
  events: AgentSessionSubscribeEvent[],
  kind: 'history' | 'close',
  population: number
) {
  const { sessions, conversationDelivery } = host.collaboratorsForTests()
  const journal = sessions.get(SESSION)!.journal
  const copies = vi.spyOn(journal, 'submissions')
  const settlement = host['clientDelivery']['sendSettlement']
  const published = vi.spyOn(settlement, 'publish')
  const reportSamples: {
    currentChild: boolean
    waiters: number
    pending: boolean
    remaining: number
    publishes: number
    submissions: number
  }[] = []
  const delivered: Promise<void>[] = []
  const handle = host.handleAdapterEvent
  const reports = vi.spyOn(host, 'handleAdapterEvent').mockImplementation((event) => {
    if (
      kind !== 'history' ||
      event.type !== 'options-reported' ||
      event.reportedOptions.reportedPermissionMode !== 'auto'
    ) {
      return handle(event)
    }
    const child = sessions.get(SESSION)?.child
    const waiters = settlement['waiters'].get(SESSION)
    const waiter = waiters?.values().next().value
    const before = {
      currentChild:
        child?.phase === 'ready' &&
        child.fence === event.fence &&
        child.generation === event.acquisitionGeneration,
      waiters: waiters?.size ?? 0,
      pending: journal.submission(waiter?.clientMessageId ?? '')?.dispatchState === 'pending'
    }
    const firstCopy = copies.mock.results.length
    const firstPublish = published.mock.calls.length
    const delivery = handle(event)
    reportSamples.push({
      ...before,
      remaining: waiters?.size ?? 0,
      publishes: published.mock.calls.length - firstPublish,
      submissions: copies.mock.results
        .slice(firstCopy)
        .reduce((sum, row) => sum + (row.type === 'return' ? row.value.length : 0), 0)
    })
    delivered.push(delivery)
    return delivery
  })
  const bodies = vi.spyOn(journal, 'itemBody')
  const cards = vi.spyOn(journal.queuedMessages, 'list')
  const plans = vi.spyOn(journal.queuedMessages, 'plan')
  const transactions = vi.spyOn(journal['database'], 'transaction')
  const commits = vi.spyOn(journal['rowWriter']['deps'], 'commit')
  let historyEntries = 0
  let comparisons = 0
  const history = journal.stoppedHistoryCarried
  const histories = vi.spyOn(journal, 'stoppedHistoryCarried').mockImplementation(() => {
    const value = history()
    historyEntries += value.size
    return value
  })
  const includes = Array.prototype.includes
  const membership = vi.spyOn(Array.prototype, 'includes').mockImplementation(function (
    this: unknown[],
    value: unknown,
    fromIndex?: number
  ) {
    const found = includes.call(this, value, fromIndex)
    if (this[0] === 'perf-kept-0' && fromIndex === undefined) {
      const index = this.indexOf(value)
      comparisons += index === -1 ? this.length : index + 1
    }
    return found
  })
  const firstEvent = events.length
  return async () => {
    try {
      await conversationDelivery.loop['runs'].get(SESSION)
      await journal['queue'].drain()
      await host.flushStreamedEvents(SESSION)
      await Promise.all(delivered)
      const work = {
        submissions: copies.mock.results.reduce(
          (sum, row) => sum + (row.type === 'return' ? row.value.length : 0),
          0
        ),
        history: historyEntries,
        reportSubmissions: reportSamples.reduce((sum, report) => sum + report.submissions, 0),
        bodies: bodies.mock.calls.length,
        cards: cards.mock.results.reduce(
          (sum, row) => sum + (row.type === 'return' ? row.value.length : 0),
          0
        ),
        transactions: transactions.mock.calls.length,
        rows: commits.mock.calls.reduce((sum, [rows]) => sum + rows.length, 0),
        publicationBytes: Buffer.byteLength(JSON.stringify(events.slice(firstEvent)))
      }
      expect(work.submissions).toBeGreaterThanOrEqual(population)
      expect(work.bodies).toBeGreaterThan(0)
      expect(work.transactions).toBeGreaterThan(0)
      expect(work.rows).toBeGreaterThan(0)
      expect(events.length).toBeGreaterThan(firstEvent)
      if (kind === 'history') {
        expect(historyEntries).toBeGreaterThanOrEqual(population - 1)
        expect(reportSamples).toHaveLength(1)
        expect(reportSamples[0]).toMatchObject({
          currentChild: true,
          waiters: 1,
          pending: true,
          remaining: 1,
          publishes: 1
        })
        expect(work.reportSubmissions).toBeGreaterThanOrEqual(population + 2)
      } else {
        expect(
          plans.mock.calls.reduce((sum, [changes]) => sum + changes.length, 0)
        ).toBeLessThanOrEqual(2 * population + 4)
        expect(comparisons).toBe(0)
        expect(work.cards).toBeGreaterThanOrEqual(population)
      }
      if (population === 100) {
        const small = inputWorkSamples.get(kind)!
        expect(small).toBeDefined()
        for (const [field, count] of Object.entries(work)) {
          expect(count, field).toBeLessThanOrEqual(12 * Math.max(1, small[field]!))
        }
      } else {
        inputWorkSamples.set(kind, work)
      }
    } finally {
      for (const mock of [
        reports,
        published,
        copies,
        bodies,
        cards,
        plans,
        transactions,
        commits,
        histories,
        membership
      ]) {
        mock.mockRestore()
      }
    }
  }
}
