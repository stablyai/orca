import { vi, type Mock, type MockInstance } from 'vitest'
import type { AgentJournalSnapshot } from '../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'

export type AutomationChatRunMeasurement = {
  measure: () => number[]
  full: MockInstance<AgentSessionJournal['snapshot']>
  observerReads: MockInstance<StructuredAgentSessionHost['journalSnapshot']>
  registration: MockInstance<StructuredAgentSessionHost['observeConversationPublications']>
  releases: Mock<() => void>[]
  keys: [
    MockInstance<AgentSessionJournal['item']>,
    MockInstance<AgentSessionJournal['submission']>,
    MockInstance<AgentSessionJournal['queuedMessages']['get']>,
    MockInstance<AgentSessionJournal['canonicalItemId']>
  ]
  timers: MockInstance<(callback: (_: void) => void, delay?: number) => NodeJS.Timeout>
  cleared: MockInstance<(timeout: NodeJS.Timeout | string | number | undefined) => void>
  details: () => {
    callbacks: number
    committedRows: number
    deltaReads: number
    deltaRows: number
    copied: number
    iteratorYields: number
    projections: number
    projectedRows: number
    scannedRows: number
  }
}

export function measureAutomationChatRun(
  journal: AgentSessionJournal,
  host: StructuredAgentSessionHost
): AutomationChatRunMeasurement {
  let itemReads = 0,
    submissionReads = 0,
    itemFinds = 0,
    rootVisits = 0,
    submissionFinds = 0,
    submissionVisits = 0,
    itemIterations = 0
  const snapshots = new WeakMap<AgentJournalSnapshot, AgentJournalSnapshot>()
  function wrapSnapshot(original: AgentJournalSnapshot): AgentJournalSnapshot {
    const prior = snapshots.get(original)
    if (prior) {
      return prior
    }
    function rows<T>(values: T[], items: boolean): T[] {
      return new Proxy(values, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key)) {
            if (items) {
              itemReads++
            } else {
              submissionReads++
            }
          }
          if (key === 'find') {
            return (predicate: (value: T, index: number, values: T[]) => unknown) => {
              if (items) {
                itemFinds++
              } else {
                submissionFinds++
              }
              return Array.prototype.find.call(receiver, (value: T, index: number, array: T[]) => {
                if (items) {
                  rootVisits++
                } else {
                  submissionVisits++
                }
                return predicate(value, index, array)
              })
            }
          }
          if (items && key === Symbol.iterator) {
            return function* () {
              for (let i = 0; i < target.length; i++) {
                itemIterations++
                yield receiver[i]
              }
            }
          }
          // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy get trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
          return Reflect.get(target, key, receiver)
        }
      })
    }
    const wrapped = {
      ...original,
      items: rows(original.items, true),
      submissions: rows(original.submissions, false)
    }
    snapshots.set(original, wrapped)
    return wrapped
  }
  let projections = 0,
    projectedRows = 0,
    scannedRows = 0
  const materialized = new WeakSet<object>()
  const realPublicRead = journal.publicRead.bind(journal)
  const publicReads = vi.spyOn(journal, 'publicRead').mockImplementation(() => {
    const view = realPublicRead()
    return {
      get normalizationKey() {
        return view.normalizationKey
      },
      get snapshot() {
        const result = view.snapshot
        if (!materialized.has(view)) {
          materialized.add(view)
          projections++
          projectedRows += result.items.length + result.submissions.length
        }
        return wrapSnapshot(result)
      }
    }
  })
  const visitItems = journal.visitItems.bind(journal)
  const visits = vi.spyOn(journal, 'visitItems').mockImplementation((visit) =>
    visitItems((...args) => {
      scannedRows++
      visit(...args)
    })
  )
  let deltaRows = 0
  const readSince = journal.readSince.bind(journal)
  const deltas = vi.spyOn(journal, 'readSince').mockImplementation((...args) => {
    const value = readSince(...args)
    if (value.ok) {
      deltaRows += value.rows.length
    }
    return value
  })
  const timers = vi.spyOn(globalThis, 'setTimeout'),
    cleared = vi.spyOn(globalThis, 'clearTimeout')
  const realSnapshot = journal.snapshot.bind(journal)
  const full = vi.spyOn(journal, 'snapshot').mockImplementation((...args) => {
    const value = realSnapshot(...args)
    return value
  })
  const releases: Mock<() => void>[] = []
  let callbacks = 0,
    committedRows = 0,
    copied = 0,
    iteratorYields = 0
  const submissions = journal.submissions.bind(journal)
  const submissionCopies = vi.spyOn(journal, 'submissions').mockImplementation(() => {
    const rows = submissions()
    copied += rows.length
    return rows
  })
  // Count actual folded history iterators, without replacing their algorithms.
  const folded = journal['state']
  const values = folded.items.values.bind(folded.items)
  vi.spyOn(folded.items, 'values').mockImplementation(function* () {
    for (const item of values()) {
      iteratorYields++
      yield item
    }
    return undefined
  })
  const fullApis = [
    'pendingSubmissions',
    'runningTurn',
    'newestTurn',
    'threadGoalSource',
    'contextUsage',
    'visitItemsWithLinkage'
  ] as const
  const calls = fullApis.map((name) => vi.spyOn(journal, name))
  const keys: AutomationChatRunMeasurement['keys'] = [
    vi.spyOn(journal, 'item'),
    vi.spyOn(journal, 'submission'),
    vi.spyOn(journal.queuedMessages, 'get'),
    vi.spyOn(journal, 'canonicalItemId')
  ]
  const observerReads = vi.spyOn(host, 'journalSnapshot')
  const realObserve = host.observeConversationPublications.bind(host)
  const registration = vi
    .spyOn(host, 'observeConversationPublications')
    .mockImplementation((id, observer) => {
      const release = realObserve(id, {
        ...observer,
        next: (hint) => {
          callbacks++
          committedRows += hint.rows?.length ?? 0
          observer.next(hint)
        }
      })
      const wrapped = vi.fn(release)
      releases.push(wrapped)
      return wrapped
    })
  const measure = () => [
    copied,
    iteratorYields,
    projections,
    projectedRows,
    scannedRows,
    full.mock.calls.length,
    ...calls.map((spy) => spy.mock.calls.length),
    publicReads.mock.calls.length,
    submissionCopies.mock.calls.length,
    visits.mock.calls.length,
    itemReads,
    submissionReads,
    itemFinds,
    rootVisits,
    submissionFinds,
    submissionVisits,
    itemIterations
  ]
  return {
    measure,
    full,
    observerReads,
    registration,
    releases,
    keys,
    timers,
    cleared,
    details: () => ({
      callbacks,
      committedRows,
      deltaReads: deltas.mock.calls.length,
      deltaRows,
      copied,
      iteratorYields,
      projections,
      projectedRows,
      scannedRows
    })
  }
}
