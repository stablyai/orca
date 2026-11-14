import { afterEach, expect, it } from 'vitest'
import { agentSessionJournalProviderHandle } from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import { rewindRefusalBehindClear } from '../../../rewind/structured-rewind-refusal'
import {
  closeAgentReadJournals,
  identity,
  journals,
  message,
  resetWork,
  roots,
  seed,
  tail,
  texts,
  write
} from './agent-read-journal-fixture'

afterEach(closeAgentReadJournals)

const clear = (
  journal: AgentSessionJournal,
  operationId: string,
  receipt = { write: () => {}, committed: () => {} }
) => journal.context.clear({ operationId, afterFence: 1, clearedAt: 1_000 }, receipt)
const CLEARED = { kind: 'message', role: 'system', text: 'Context cleared' } as const

/** APPLE and BANANA, then `/clear`. */
async function clearedChat() {
  const journal = await seed(0, () => null)
  await write(journal, 'apple', [['apple', 'APPLE']])
  await write(journal, 'banana', [['banana', 'BANANA']])
  tail(journal, 100)
  await clear(journal, 'clear-1')
  return journal
}

it('reads only the current context after /clear, from its divider', async () => {
  const journal = await clearedChat()
  expect(tail(journal, 100)).toMatchObject({ entries: [CLEARED], limited: false })

  await write(journal, 'cherry', [['cherry', 'CHERRY']])
  // An old item revised after the clear stays out of the current context.
  await write(journal, 'apple again', [['apple', 'APPLE revised']])

  expect(tail(journal, 100)).toMatchObject({
    entries: [CLEARED, { text: 'CHERRY' }],
    limited: false
  })
  expect(tail(journal, 1)).toMatchObject({ entries: [{ text: 'CHERRY' }], limited: true })
  expect(tail(journal, 2)).toMatchObject({ entries: [CLEARED, { text: 'CHERRY' }], limited: false })
  // The archive keeps the old context.
  expect(journal.statusRead().items.some((item) => item.itemId === 'apple')).toBe(true)
})

it('starts the current context at the newest of repeated clears, and after reopening', async () => {
  const journal = await clearedChat()
  await write(journal, 'cherry', [['cherry', 'CHERRY']])
  await clear(journal, 'clear-2')
  await write(journal, 'date', [['date', 'DATE']])
  expect(texts(tail(journal, 100))).toEqual(['Context cleared', 'DATE'])

  await journal.close()
  const reopened = await journals.open({ identity, stateDirectory: roots.at(-1) ?? '' })

  expect(texts(tail(reopened, 100))).toEqual(['Context cleared', 'DATE'])
})

it.each([1_000, 10_000])(
  'reads the current context after %i cleared replies without walking them',
  async (count) => {
    const journal = await seed(count, (index) => message(`reply ${index}`))
    tail(journal, 1)
    const work = resetWork(journal)
    await clear(journal, 'clear')
    await write(journal, 'cherry', [['cherry', 'CHERRY']])

    expect(texts(tail(journal, 100))).toEqual(['Context cleared', 'CHERRY'])
    // Two placements and a walk of the two current entries: tree paths, never the old context.
    expect({ upkeep: work.upkeep, builds: work.builds, reads: work.reads }).toEqual({
      upkeep: 2,
      builds: 0,
      reads: 2
    })
    expect(work.nodes).toBeLessThan(80)
  }
)

it('leaves the read untouched when a clear commits no divider', async () => {
  const journal = await clearedChat()
  await write(journal, 'cherry', [['cherry', 'CHERRY']])
  const before = tail(journal, 100)
  const head = journal.cursor()

  // The receipt's write failing rolls the clear back: no divider is committed.
  await expect(
    clear(journal, 'refused', {
      write: () => {
        throw new Error('refused-clear')
      },
      committed: () => {}
    })
  ).rejects.toThrow('refused-clear')

  expect(journal.cursor()).toEqual(head)
  expect(tail(journal, 100)).toEqual(before)
})

it.each(['plain', 'forked'] as const)(
  'rewinds within the current context (%s), keeping its divider, and refuses a target before it',
  async (kind) => {
    const journal = await clearedChat()
    await write(journal, 'cherry', [['cherry', 'CHERRY']])
    const before = tail(journal, 100)
    const floor = journal.context.floor()
    const work = resetWork(journal)

    // A rewind to an item before the divider is refused before any agent runs.
    const epoch = journal.cursor().epoch
    expect(
      rewindRefusalBehindClear(journal, { itemId: 'banana', expectedEpoch: epoch })
    ).not.toBeNull()
    expect(rewindRefusalBehindClear(journal, { itemId: 'cherry', expectedEpoch: epoch })).toBeNull()
    expect(tail(journal, 100)).toEqual(before)

    await journal.context.rewind(
      floor ?? { epoch, sequence: 0 },
      1,
      [],
      () => ({ write: () => {}, committed: () => {} }),
      // A provider that forked its history starts a new epoch, as structured rewind recovery does.
      kind === 'forked'
        ? { reason: 'handle_forked', providerHandle: agentSessionJournalProviderHandle(identity) }
        : undefined
    )

    expect(tail(journal, 100)).toMatchObject({ entries: [CLEARED], limited: false })
    // A new epoch rebuilds the read owner from what survived; the same epoch keeps it.
    expect(work.builds).toBe(kind === 'forked' ? 1 : 0)
  }
)
