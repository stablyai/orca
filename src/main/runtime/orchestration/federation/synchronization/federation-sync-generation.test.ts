import { describe, expect, it } from 'vitest'
import { createIdleSyncHarness } from './federation-sync-test-harness'

describe('federation sync generation', () => {
  it.each(['stopRelay', 'database swap'] as const)(
    'keeps a sync interrupted by %s from acknowledging into current state',
    async (interruption) => {
      const { runtime, blockAck, replaceDb } = createIdleSyncHarness()
      const gate = blockAck()

      const oldSync = runtime.syncOrchestrationFederatedDispatch('dispatch_remote')
      await gate.reached
      if (interruption === 'stopRelay') {
        runtime.stopOrchestrationFederationRelay()
      } else {
        replaceDb()
      }
      gate.release()
      await oldSync

      expect(
        runtime.getOrchestrationDb().getFederatedDispatch('dispatch_remote')
          ?.to_home_acknowledged_sequence
      ).toBe(0)
    }
  )
})
