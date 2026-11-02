import { vi } from 'vitest'
import { createRetainedMaterializerCounters } from './structured-agent-session-retained-materializer-counters.test-fixture'
import * as reducer from '../agent-session-journal/journal-reducer'
import * as transitions from '../agent-session-journal/journal-reducer-transition'
import { JournalInputOrder } from '../agent-session-journal/journal-input-order'
import { JournalQueuedMessages } from '../agent-session-journal/journal-queued-messages'
import { JournalInputCardIndex } from '../agent-session-journal/journal-input-card-index'
import { JournalInputPlaceIndex } from '../agent-session-journal/journal-input-place-index'

export function createRetainedReadCounters() {
  type Counts = {
    fullViews: number
    fullInputs: number
    fullIterations: number
    fullRenders: number
    archived: number
    records: number
    indexed: number
    restores: number
    nodes: number
    drafts: number
    points: number
    paths: number
    endpoints: number
    statusRecords: number
    statusItems: number
  }
  const phases: Record<string, Counts> = {}
  let phase = 'setup'
  const count = () =>
    (phases[phase] ??= {
      fullViews: 0,
      fullInputs: 0,
      fullIterations: 0,
      fullRenders: 0,
      archived: 0,
      records: 0,
      indexed: 0,
      restores: 0,
      nodes: 0,
      drafts: 0,
      points: 0,
      paths: 0,
      endpoints: 0,
      statusRecords: 0,
      statusItems: 0
    })
  const archived = (id: unknown) =>
    typeof id === 'string' && /^archive-(withdrawn|sent|input|stopped)-/.test(id)
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item)
      }
      return
    }
    if (typeof value === 'string') {
      if (archived(value)) {
        count().archived++
      }
      return
    }
    if (!value || typeof value !== 'object') {
      return
    }
    const id =
      'messageId' in value
        ? value.messageId
        : 'clientMessageId' in value
          ? value.clientMessageId
          : 'card' in value &&
              value.card &&
              typeof value.card === 'object' &&
              'messageId' in value.card
            ? value.card.messageId
            : undefined
    if (typeof id === 'string') {
      count().records++
      if (archived(id)) {
        count().archived++
      }
    }
  }
  const inputMaps = new WeakSet<object>()
  const materializers = createRetainedMaterializerCounters(count, visit, inputMaps)
  type Tree = NonNullable<JournalInputPlaceIndex['all']>
  let querying = 0
  const observeNode = (node: Tree | undefined): Tree | undefined =>
    node &&
    new Proxy(node, {
      get(target, key: keyof typeof target) {
        count().paths++
        return key === 'left' || key === 'right' ? observeNode(target[key]) : target[key]
      }
    })
  const atPath = <T>(index: JournalInputPlaceIndex, run: () => T): T => {
    const root = index['all']
    index['all'] = observeNode(root)
    try {
      return run()
    } finally {
      index['all'] = root
    }
  }
  const maximumAfter = JournalInputPlaceIndex.prototype.maximumAfter
  const firstPosition = JournalInputPlaceIndex.prototype.firstPosition
  const lastId = JournalInputPlaceIndex.prototype.lastId
  const successorId = JournalInputPlaceIndex.prototype.successorId
  const idsAfter = JournalInputPlaceIndex.prototype.idsAfter
  const pathSpies = [
    vi.spyOn(JournalInputPlaceIndex.prototype, 'maximumAfter').mockImplementation(function (
      this: JournalInputPlaceIndex,
      sequence
    ) {
      return atPath(this, () => maximumAfter.call(this, sequence))
    }),
    vi.spyOn(JournalInputPlaceIndex.prototype, 'idsAfter').mockImplementation(function (
      this: JournalInputPlaceIndex,
      sequence
    ) {
      return atPath(this, () => idsAfter.call(this, sequence))
    }),
    vi.spyOn(JournalInputPlaceIndex.prototype, 'firstPosition').mockImplementation(function (
      this: JournalInputPlaceIndex
    ) {
      return atPath(this, () => firstPosition.call(this))
    }),
    vi.spyOn(JournalInputPlaceIndex.prototype, 'lastId').mockImplementation(function (
      this: JournalInputPlaceIndex
    ) {
      return atPath(this, () => lastId.call(this))
    }),
    vi.spyOn(JournalInputPlaceIndex.prototype, 'successorId').mockImplementation(function (
      this: JournalInputPlaceIndex,
      sequence
    ) {
      return atPath(this, () => successorId.call(this, sequence))
    })
  ]
  const query = JournalInputPlaceIndex.prototype.query
  const queries = vi.spyOn(JournalInputPlaceIndex.prototype, 'query').mockImplementation(function (
    this: JournalInputPlaceIndex,
    ...args
  ) {
    querying++
    try {
      return query.apply(this, args)
    } finally {
      querying--
    }
  })
  const status = JournalInputOrder.prototype.statusInputs
  const stoppedInputs = JournalInputOrder.prototype.stoppedHistoryInputs
  const stoppedReads = vi
    .spyOn(JournalInputOrder.prototype, 'stoppedHistoryInputs')
    .mockImplementation(function (this: JournalInputOrder, ...args) {
      return new Proxy(stoppedInputs.apply(this, args), {
        get(target, key: keyof typeof target) {
          const value = target[key]
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            visit(value)
          }
          return value
        }
      })
    })
  const statuses = vi
    .spyOn(JournalInputOrder.prototype, 'statusInputs')
    .mockImplementation(function (this: JournalInputOrder, ...args) {
      const result = status.apply(this, args)
      return new Proxy(result, {
        get(target, key: keyof typeof target) {
          const value = target[key]
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            count().statusRecords++
            const input = target[Number(key)]
            if (input && archived(input.clientMessageId)) {
              count().endpoints++
            }
          }
          return value
        }
      })
    })
  const renderState = reducer.renderJournalState
  const fullRenders = vi.spyOn(reducer, 'renderJournalState').mockImplementation((...args) => {
    count().fullRenders++
    return renderState(...args)
  })
  const renderItems = reducer.renderJournalItems
  const rendered = vi.spyOn(reducer, 'renderJournalItems').mockImplementation(
    (...args) =>
      new Proxy(renderItems(...args), {
        get(target, key: keyof typeof target) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            count().statusItems++
          }
          return target[key]
        }
      })
  )
  const get = Map.prototype.get
  const mg = vi.spyOn(Map.prototype, 'get').mockImplementation(function (key) {
    if (archived(key)) {
      count().points++
    }
    const value = get.call(this, key)
    return querying && value && typeof value === 'object' && 'height' in value && 'entry' in value
      ? observeNode(value)
      : value
  })
  const list = JournalQueuedMessages.prototype.list
  const lists = vi.spyOn(JournalQueuedMessages.prototype, 'list').mockImplementation(function (
    this: JournalQueuedMessages
  ) {
    return new Proxy(list.call(this), {
      get(target, key: keyof typeof target) {
        const value: unknown = target[key]
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          visit(value)
        }
        return value
      }
    })
  })
  const index = JournalInputCardIndex.prototype.indexCard
  const indexed = vi
    .spyOn(JournalInputCardIndex.prototype, 'indexCard')
    .mockImplementation(function (this: JournalInputCardIndex, ...args) {
      count().indexed++
      visit(args[1])
      return index.apply(this, args)
    })
  const restore = JournalInputOrder.prototype.restore
  const restores = vi.spyOn(JournalInputOrder.prototype, 'restore').mockImplementation(function (
    this: JournalInputOrder,
    ...args
  ) {
    inputMaps.add(args[0].submissions)
    count().restores++
    return restore.apply(this, args)
  })
  const reflect = Reflect.get
  const nodes = vi.spyOn(Reflect, 'get').mockImplementation((...args) => {
    if ('height' in args[0] && 'entry' in args[0]) {
      count().nodes++
    }
    return reflect(...args)
  })
  const isolate = transitions.isolateJournalTransition
  const drafts = vi.spyOn(transitions, 'isolateJournalTransition').mockImplementation((...args) => {
    const draft = isolate(...args)
    return {
      ...draft,
      adopt: () => {
        const result = draft.adopt()
        count().drafts += draft.trackedDerived()
        return result
      }
    }
  })
  return {
    phases,
    archived,
    count,
    watchJournal: materializers.watchJournal,
    setPhase: (name: string) => {
      phase = name
    },
    dispose: () => {
      materializers.dispose()
      for (const spy of [
        mg,
        lists,
        indexed,
        restores,
        nodes,
        drafts,
        statuses,
        stoppedReads,
        rendered,
        fullRenders,
        queries,
        ...pathSpies
      ]) {
        spy.mockRestore()
      }
    }
  }
}
