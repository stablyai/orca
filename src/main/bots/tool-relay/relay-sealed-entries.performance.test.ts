// Guards #51086: each kept-caller change writes only its own entry, so N serial launches serialize N
// records, never a whole-population rewrite per launch (N(N+1)/2).
import { describe, expect, it } from 'vitest'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'
import { RelaySealedEntries } from './relay-sealed-entries'

type Run = { sessionId: string; runFence: number }
const isRun = (value: unknown): value is Run =>
  typeof jsonProperty(value, 'sessionId') === 'string' &&
  typeof jsonProperty(value, 'runFence') === 'number'

async function serial(chats: number): Promise<{ serialized: number; removed: number }> {
  let serialized = 0
  let removed = 0
  const entries = new RelaySealedEntries<Run>(
    '/unused',
    isRun,
    (run) => `${run.sessionId}\n${run.runFence}`,
    {
      publish: async (_path, payload) => {
        serialized += isRun(jsonProperty(JSON.parse(payload), 'entry')) ? 1 : 0
      },
      remove: async () => {
        removed += 1
      }
    }
  )
  // Each chat launches, then relaunches once (its earlier run retires): every write awaited in turn.
  for (let chat = 0; chat < chats; chat += 1) {
    await entries.put({ sessionId: `chat-${chat}`, runFence: 1 })
  }
  for (let chat = 0; chat < chats; chat += 1) {
    await entries.put({ sessionId: `chat-${chat}`, runFence: 2 })
    await entries.delete({ sessionId: `chat-${chat}`, runFence: 1 })
  }
  return { serialized, removed }
}

describe('kept relay entry writes', () => {
  it('serializes one record per serial change, at N and 10N kept chats', async () => {
    for (const chats of [100, 1_000]) {
      expect(await serial(chats)).toEqual({ serialized: 2 * chats, removed: chats })
    }
  })
})
