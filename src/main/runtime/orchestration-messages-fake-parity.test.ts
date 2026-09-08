import { describe, expect, it } from 'vitest'
import { InMemoryOrchestrationMessages } from './orca-runtime-test-orchestration-messages.spec'
import { OrchestrationDb } from './orchestration/db'
import type { MessageType } from './orchestration/types'

type PointerTarget = { ptyId: string; processIncarnation: string }

// The slice of the mailbox store the pointer batch selector depends on.
type PointerStore = {
  insertMessage(message: { from: string; to: string; subject: string; type?: MessageType }): {
    id: string
  }
  stageMailboxPointerEnter(ids: string[], target: PointerTarget): boolean
  markMailboxPointerWriteAttempted(ids: string[], target: PointerTarget): boolean
  getUndeliveredUnreadMessages(
    toHandle: string,
    types?: MessageType[],
    options?: { excludeTypes?: readonly string[]; limit?: number }
  ): { id: string }[]
}

// Why: runtime tests drive the in-memory fake, so a reservation race it cannot lose is a race
// those tests can never cover. Both stores must answer the same question the same way.
const STORES: [string, () => PointerStore][] = [
  ['real sqlite', () => new OrchestrationDb(':memory:')],
  ['in-memory fake', () => new InMemoryOrchestrationMessages()]
]

describe.each(STORES)('mailbox pointer reservations (%s)', (_name, createStore) => {
  const rival = { ptyId: 'pty-rival', processIncarnation: 'rival:1' }
  const mine = { ptyId: 'pty-mine', processIncarnation: 'mine:1' }

  it('refuses a claim another flight already holds', () => {
    const store = createStore()
    const message = store.insertMessage({ from: 'a', to: 'run:run-1', subject: 'contended' })

    expect(store.stageMailboxPointerEnter([message.id], rival)).toBe(true)
    expect(store.stageMailboxPointerEnter([message.id], mine)).toBe(false)
    expect(store.markMailboxPointerWriteAttempted([message.id], mine)).toBe(false)
  })

  it('rolls the whole batch back when one row is already claimed', () => {
    const store = createStore()
    const free = store.insertMessage({ from: 'a', to: 'run:run-1', subject: 'free' })
    const taken = store.insertMessage({ from: 'a', to: 'run:run-1', subject: 'taken' })
    expect(store.stageMailboxPointerEnter([taken.id], rival)).toBe(true)

    expect(store.stageMailboxPointerEnter([free.id, taken.id], mine)).toBe(false)
    // The partial claim must not survive: the free row stays available to the next flight.
    expect(store.stageMailboxPointerEnter([free.id], mine)).toBe(true)
  })

  it('applies the exclusion and limit the pointer batch selector relies on', () => {
    const store = createStore()
    store.insertMessage({ from: 'a', to: 'run:run-1', subject: 'reserved', type: 'escalation' })
    const kept = store.insertMessage({ from: 'a', to: 'run:run-1', subject: 'kept' })

    expect(
      store
        .getUndeliveredUnreadMessages('run:run-1', undefined, { excludeTypes: ['escalation'] })
        .map((message) => message.id)
    ).toEqual([kept.id])
    expect(store.getUndeliveredUnreadMessages('run:run-1', undefined, { limit: 1 })).toHaveLength(1)
  })
})
