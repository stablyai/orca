import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import type { OrchestrationDb } from '../../orchestration/db'

describe('orchestration MoA RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let ctx: RpcContext

  function setup(): void {
    ;({ db, ctx } = h.setup(true))
  }

  afterEach(() => {
    h.cleanup()
  })

  async function call(name: string, params: Record<string, unknown>) {
    return h.call(name, params, ctx)
  }

  describe('orchestration.moaLog', () => {
    it('records entries in the caller run and reports duplicates', async () => {
      setup()
      const entries = [
        { kind: 'proposal', seat: 'seat-A', rationale: 'tables as store' },
        { kind: 'verdict', round: 2, seat: 'seat-B', verdict: 'support' }
      ]
      const first = (await call('orchestration.moaLog', {
        deliberation: 'ledger-storage',
        seatCount: 3,
        entries
      })) as { deliberation: { id: string; seat_count: number }; inserted: number }
      expect(first.deliberation.id).toBe('ledger-storage')
      expect(first.deliberation.seat_count).toBe(3)
      expect(first.inserted).toBe(2)

      const replay = (await call('orchestration.moaLog', {
        deliberation: 'ledger-storage',
        entries
      })) as { inserted: number; duplicates: number }
      expect(replay.inserted).toBe(0)
      expect(replay.duplicates).toBe(2)
    })

    it('surfaces store validation errors for invalid kinds', async () => {
      setup()
      await expect(
        call('orchestration.moaLog', {
          deliberation: 'd1',
          entries: [{ kind: 'vote' }]
        })
      ).rejects.toThrow(/Invalid MoA entry kind/)
    })
  })

  describe('orchestration.moaShow', () => {
    it('lists deliberations without --deliberation and entries with it', async () => {
      setup()
      await call('orchestration.moaLog', {
        deliberation: 'd1',
        entries: [
          { kind: 'proposal', round: 1, seat: 'seat-A' },
          { kind: 'verdict', round: 2, seat: 'seat-B', verdict: 'merge' }
        ]
      })

      const catalog = (await call('orchestration.moaShow', {})) as {
        deliberations: { id: string }[]
        count: number
      }
      expect(catalog.count).toBe(1)
      expect(catalog.deliberations[0].id).toBe('d1')

      const full = (await call('orchestration.moaShow', { deliberation: 'd1' })) as {
        entries: { entry_kind: string; round: number }[]
      }
      expect(full.entries).toHaveLength(2)

      const roundTwo = (await call('orchestration.moaShow', {
        deliberation: 'd1',
        round: 2
      })) as { entries: { entry_kind: string }[] }
      expect(roundTwo.entries).toHaveLength(1)
      expect(roundTwo.entries[0].entry_kind).toBe('verdict')
    })

    it('hides deliberations that belong to another run', async () => {
      setup()
      const foreign = db.createRun({
        objective: 'foreign run',
        coordinatorHandle: 'term_foreign',
        coordinatorPaneKey: 'tab_foreign:leaf_foreign'
      })
      db.logMoaEntries({
        runId: foreign.id,
        deliberationId: 'foreign-deliberation',
        entries: [{ kind: 'note' }]
      })
      // Why: the caller's implicit run must not see (or even confirm the existence of) the foreign ledger.
      await expect(
        call('orchestration.moaShow', { deliberation: 'foreign-deliberation' })
      ).rejects.toThrow(/not found/)
    })
  })
})
