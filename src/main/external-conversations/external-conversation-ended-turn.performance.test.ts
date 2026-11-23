import { expect, it } from 'vitest'
import type { ConversationChat } from './external-conversation-chat'
import { endedTurn } from './external-conversation-ended-turn'

// Guards #47514 (audit 19): a wake-up's end reads each launching row and each send once, however
// many of the runs it names share them, so a burst of runs launched together costs two reads.

it('reads each launching row and send once for a wake-up naming many runs', async () => {
  const runs = Array.from({ length: 16 }, (_, index) => `r${index}`)
  const wakeRow = {
    itemId: 'wake-row',
    sequence: 2,
    revision: 0,
    observedAt: 2,
    body: {
      kind: 'turn',
      turnId: 't2',
      state: 'completed',
      startedAt: 2,
      userItemId: 'wake-row',
      wokenBy: runs,
      wokeFrom: runs.map((run) => ({ run, turn: 'launching-row' }))
    }
  }
  const launchingRow = {
    itemId: 'launching-row',
    sequence: 1,
    revision: 0,
    observedAt: 1,
    body: {
      kind: 'turn',
      turnId: 't1',
      state: 'completed',
      startedAt: 1,
      userItemId: 'c1-row',
      launches: runs.map((run) => ({ run, sends: ['c1'], runs: [] }))
    }
  }
  const cursor = { epoch: 'e', sequence: 2 }
  let rowReads = 0
  let sendReads = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: endedTurn reads only these journal reads; the rows are journal-shaped.
  const chat = {
    journalReads: async () => ({
      operationWindow: async () => ({ snapshot: { items: [wakeRow], submissions: [], cursor } }),
      canonicalItemIds: async () => new Map(),
      cursor: async () => cursor,
      item: async () => {
        rowReads += 1
        return launchingRow
      },
      submissionBody: async () => {
        sendReads += 1
        return { kind: 'message', role: 'user', blocks: [] }
      }
    })
  } as unknown as ConversationChat
  const turn = await endedTurn(chat, 'chat-1', 't2', cursor)
  expect(turn.wake?.launches).toHaveLength(16)
  expect({ rowReads, sendReads }).toEqual({ rowReads: 1, sendReads: 1 })
})
