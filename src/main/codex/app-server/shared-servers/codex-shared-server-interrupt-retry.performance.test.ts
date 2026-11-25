import { afterEach, expect, it, vi } from 'vitest'
import { chat, fakeCodex, launch, startThread } from './codex-shared-server-pool-fixture'

afterEach(() => {
  vi.useRealTimers()
})

it('never re-sends a refused interrupt in a background loop', async () => {
  vi.useFakeTimers()
  const { servers, pool } = fakeCodex('ignored', 'exited', true, { interruptRefused: true })
  const a = chat()
  const connA = await pool.open(
    launch(),
    {
      ...a.handlers,
      onNotification: (method) => {
        if (method === 'item/broken') {
          throw new Error('chat handler failed')
        }
      }
    },
    { sessionId: 'a', skillRoots: [] }
  )
  await pool.open(launch(), chat().handlers, { sessionId: 'b', skillRoots: [] })
  const threadA = await startThread(connA)
  servers[0]!.handlers.onNotification?.('turn/started', { threadId: threadA, turn: { id: 't' } })
  const interrupts = () => servers[0]!.requests.filter((r) => r.method === 'turn/interrupt').length
  // A failed chat cleans up on its own; a refused interrupt must not make that a loop.
  servers[0]!.handlers.onNotification?.('item/broken', { threadId: threadA })
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  const afterTenMinutes = interrupts()
  expect(afterTenMinutes).toBeLessThanOrEqual(2)
})
