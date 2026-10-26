import { expect, it } from 'vitest'
import { tearDownRuntime, type InstalledRuntime } from './structured-agent-session-runtime-teardown'

// An exit that settles while teardown drains recovery wakes delivery; a fresh child started then
// would only be killed by the teardown after it.
it('stops delivery before it drains the recovery of exits already observed', async () => {
  const order: string[] = []
  const installed: InstalledRuntime = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown calls only `stopDelivery` and `flushAllStreamedEvents` on the host.
    host: {
      stopDelivery: () => order.push('stop-delivery'),
      flushAllStreamedEvents: async () => {
        order.push('flush')
      }
    } as never,
    adapter: { closeAll: async () => undefined },
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown calls only `close` on the database.
    journalDatabase: { close: () => order.push('close-database') } as never,
    waitForRecovery: async () => {
      order.push('wait-for-recovery')
    }
  }

  await tearDownRuntime(installed, 'quit')

  expect(order.slice(0, 2)).toEqual(['stop-delivery', 'wait-for-recovery'])
})
