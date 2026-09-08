import { describe, expect, it, vi } from 'vitest'
import { handleRendererDeliveryStateReport } from './pty/delivery/renderer-delivery-state-report'
import { writeOffLostRendererDelivery } from './pty/delivery/accounting'
import type { PtyIpcSession, RendererPtyDeliveryAccounting } from './pty/session'

vi.mock('./pty/provider/registry', () => ({ tryGetProviderForPty: () => undefined }))

describe('bounded delivery health recovery candidates', () => {
  it.each(['streaming', 'parse-pending'] as const)(
    'keeps a small lost delivery ahead of thirty larger %s debts without writing them off',
    (siblingState) => {
      const now = Date.now()
      const accounting = new Map<string, RendererPtyDeliveryAccounting>()
      const received: Record<string, number> = {}
      for (let index = 0; index < 30; index++) {
        const id = `sibling-${index}`
        accounting.set(id, {
          sentChars: 2000,
          ackedChars: 1000,
          lastSendAtMs: now,
          lastAckAtMs: siblingState === 'streaming' ? now : now - 60_000
        })
        received[id] = 2000
      }
      accounting.set('lost', {
        sentChars: 100,
        ackedChars: 0,
        lastSendAtMs: now - 60_000,
        lastAckAtMs: null
      })
      const session = {
        rendererDeliveryAccountingByPty: accounting,
        rendererInFlightTotalChars: 30100,
        lastAckReceivedAtMs: now,
        pendingData: new Map(),
        schedulePendingDataAfterCreditReport: vi.fn(),
        readCurrentPtyRendererDeliveryDebugSnapshot: () => ({})
      } as unknown as PtyIpcSession
      session.writeOffLostRendererDelivery = (report, silentIds) =>
        writeOffLostRendererDelivery(session, report, silentIds)
      const report = { receivedCharsByPty: received, processedCharsByPty: {} }

      const health = handleRendererDeliveryStateReport(session, report)
      expect(health.inFlightPtyCount).toBe(31)
      expect(health.stalledPtys).toHaveLength(30)
      expect(health.stalledPtys?.[0]?.id).toBe('lost')

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const healed = handleRendererDeliveryStateReport(session, { ...report, heal: true })
        expect(healed.writtenOff).toEqual([{ id: 'lost', writtenOffChars: 100 }])
        expect(healed.inFlightTotalChars).toBe(30000)
        for (let index = 0; index < 30; index++) {
          expect(accounting.get(`sibling-${index}`)?.ackedChars).toBe(1000)
        }
      } finally {
        warn.mockRestore()
      }
    }
  )
})
