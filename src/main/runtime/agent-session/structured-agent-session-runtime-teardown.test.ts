import { expect, it, vi } from 'vitest'
import { tearDownRuntime, type InstalledRuntime } from './structured-agent-session-runtime-teardown'

// An exit that settles while teardown drains recovery wakes delivery; a fresh child started then
// would only be killed by the teardown after it.
it('stops delivery before it drains the recovery of exits already observed', async () => {
  const order: string[] = []
  const drained = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  const installed: InstalledRuntime = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown calls only `stopDelivery` and `flushAllStreamedEvents` on the host.
    host: {
      stopDelivery: () => order.push('stop-delivery'),
      drainStatusWrites: async () => {
        order.push('drain-status')
        await drained.promise
      },
      flushAllStreamedEvents: async () => {
        order.push('flush')
      }
    } as never,
    adapter: { closeAll: async () => undefined },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown calls only `close` on the database.
    journalDatabase: {
      close: async () => {
        order.push('close-database')
        await closing.promise
      }
    } as never,
    waitForRecovery: async () => {
      order.push('wait-for-recovery')
    }
  }

  let finished = false
  const stopping = tearDownRuntime(installed, 'quit').then(() => {
    finished = true
  })
  await vi.waitFor(() => expect(order).toContain('drain-status'))
  expect(order).not.toContain('close-database')
  drained.resolve()
  await vi.waitFor(() => expect(order).toContain('close-database'))
  expect(finished).toBe(false)
  closing.resolve()
  await stopping

  expect(order).toEqual([
    'stop-delivery',
    'wait-for-recovery',
    'flush',
    'wait-for-recovery',
    'drain-status',
    'close-database'
  ])
})
