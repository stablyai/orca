import { describe, expect, it } from 'vitest'
import { InMemoryOrchestrationMessages } from './orca-runtime-test-orchestration-messages.spec'
import { OrchestrationDb } from './orchestration/db'
import type { MessageType } from './orchestration/types'

type PointerTarget = { ptyId: string; processIncarnation: string }

type PointerStore = {
  insertMessage(message: {
    runId: string
    from: string
    to: string
    subject: string
    type?: MessageType
  }): { id: string }
  stageMailboxPointerEnter(ids: string[], target: PointerTarget): boolean
  markMailboxPointerWriteAttempted(ids: string[], target: PointerTarget): boolean
  getUndeliveredUnreadMessages(
    toHandle: string,
    types?: MessageType[],
    options?: { excludeTypes?: readonly string[]; limit?: number }
  ): { id: string }[]
}

// The in-memory fake must reproduce SQLite reservation races for runtime tests to cover them.
const STORES: [string, () => PointerStore][] = [
  ['real sqlite', () => new OrchestrationDb(':memory:')],
  ['in-memory fake', () => new InMemoryOrchestrationMessages()]
]

describe.each(STORES)('mailbox pointer reservations (%s)', (_name, createStore) => {
  const rival = { ptyId: 'pty-rival', processIncarnation: 'rival:1' }
  const mine = { ptyId: 'pty-mine', processIncarnation: 'mine:1' }

  it('refuses a claim another flight already holds', () => {
    const store = createStore()
    const message = store.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 'contended'
    })

    expect(store.stageMailboxPointerEnter([message.id], rival)).toBe(true)
    expect(store.stageMailboxPointerEnter([message.id], mine)).toBe(false)
    expect(store.markMailboxPointerWriteAttempted([message.id], mine)).toBe(false)
  })

  it('rolls the whole batch back when one row is already claimed', () => {
    const store = createStore()
    const free = store.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 'free'
    })
    const taken = store.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 'taken'
    })
    expect(store.stageMailboxPointerEnter([taken.id], rival)).toBe(true)

    expect(store.stageMailboxPointerEnter([free.id, taken.id], mine)).toBe(false)
    // A failed partial claim must leave the free row available to another flight.
    expect(store.stageMailboxPointerEnter([free.id], mine)).toBe(true)
  })

  it('applies the exclusion and limit the pointer batch selector relies on', () => {
    const store = createStore()
    store.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 'reserved',
      type: 'escalation'
    })
    const kept = store.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 'kept'
    })

    expect(
      store
        .getUndeliveredUnreadMessages('run:run-1', undefined, { excludeTypes: ['escalation'] })
        .map((message) => message.id)
    ).toEqual([kept.id])
    expect(store.getUndeliveredUnreadMessages('run:run-1', undefined, { limit: 1 })).toHaveLength(1)
  })
})
