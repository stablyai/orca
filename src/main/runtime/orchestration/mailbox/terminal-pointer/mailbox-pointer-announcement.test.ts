import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import {
  WRITE_ACCEPTED,
  type WriteSettlement
} from '../../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

const TERMINAL = {
  ptyId: 'pty-1',
  handle: 'term-1',
  paneKeys: ['tab-1:leaf-1'],
  lastAgentStatus: 'idle' as const,
  lastAgentStatusObservedLive: true
}

function pointerDeps(
  db: OrchestrationDb,
  writePty: (ptyId: string, data: string) => WriteSettlement
) {
  return {
    mailboxOwner: { resolve: () => 'run:run-1' },
    deliveryTarget: { resolveTerminal: () => TERMINAL, deferForAbsenceProbe: () => false },
    getDb: () => db,
    getTerminal: () => TERMINAL,
    // Hold the pane settled to isolate the announcement hold from the idle gate.
    isAgentSettledForDelivery: () => true,
    getMessageWaiters: () => undefined,
    getCliCommand: () => 'orca' as const,
    resolveSubmitTarget: () => ({ terminal: TERMINAL, processIncarnation: 'inc-1' }),
    isLeafPtyProvenAbsent: async () => false,
    isPtyAwaitingUserInput: () => false,
    redriveMailbox: vi.fn(),
    getWindowsPointerEnterDelayMs: () => null,
    writePty
  }
}

describe('pointers for mail an earlier pointer already announced (#41854)', () => {
  async function deliverAndSubmit(delivery: OrchestrationMailboxPointerDelivery<never>) {
    delivery.deliver(TERMINAL, { mailboxHandle: 'run:run-1', skipAbsenceProbe: true })
    await vi.advanceTimersByTimeAsync(600)
  }

  function pointerTexts(writePty: ReturnType<typeof vi.fn>): string[] {
    return writePty.mock.calls.map((call) => String(call[1])).filter((data) => data !== '\r')
  }

  it('types no pointer for mail the announced turn checked', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    try {
      const writePty = vi.fn(() => WRITE_ACCEPTED)
      const delivery = new OrchestrationMailboxPointerDelivery<never>(
        pointerDeps(db, writePty) as never
      )
      const first = db.insertMessage({ from: 'a', to: 'run:run-1', subject: 'A' })
      await deliverAndSubmit(delivery)
      delivery.observeAgentWorking('pty-1')

      // Arrives mid-turn, before the turn's check: a second pointer would queue behind it.
      const second = db.insertMessage({ from: 'b', to: 'run:run-1', subject: 'B' })
      await deliverAndSubmit(delivery)
      db.markAsRead([first.id, second.id], { kind: 'terminal', handle: 'term-1' })
      delivery.observeAgentIdle('pty-1')
      await deliverAndSubmit(delivery)

      expect(pointerTexts(writePty)).toHaveLength(1)
    } finally {
      db.close()
      vi.useRealTimers()
    }
  })

  it('points held mail once the turn ends without a check', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    try {
      const writePty = vi.fn(() => WRITE_ACCEPTED)
      const delivery = new OrchestrationMailboxPointerDelivery<never>(
        pointerDeps(db, writePty) as never
      )
      db.insertMessage({ from: 'a', to: 'run:run-1', subject: 'A' })
      await deliverAndSubmit(delivery)
      delivery.observeAgentWorking('pty-1')
      db.insertMessage({ from: 'b', to: 'run:run-1', subject: 'B' })
      await deliverAndSubmit(delivery)
      db.insertMessage({ from: 'c', to: 'run:run-1', subject: 'C' })
      await deliverAndSubmit(delivery)
      expect(pointerTexts(writePty)).toHaveLength(1)

      delivery.observeAgentIdle('pty-1')
      await deliverAndSubmit(delivery)

      const pointers = pointerTexts(writePty)
      expect(pointers).toHaveLength(2)
      expect(pointers[1]).toContain('You have 2 orchestration messages')
    } finally {
      db.close()
      vi.useRealTimers()
    }
  })

  it('points held mail when the announced Enter never starts a turn', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    try {
      const writePty = vi.fn(() => WRITE_ACCEPTED)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies only the deps delivery reads.
      const delivery = new OrchestrationMailboxPointerDelivery<never>({
        ...pointerDeps(db, writePty),
        redriveMailbox: (handle: string) =>
          delivery.deliver(TERMINAL, { mailboxHandle: handle, skipAbsenceProbe: true })
      } as never)
      db.insertMessage({ from: 'a', to: 'run:run-1', subject: 'A' })
      await deliverAndSubmit(delivery)
      // The Enter was lost: the pane stays idle and never starts the announced turn.
      delivery.observeAgentIdle('pty-1')
      db.insertMessage({ from: 'b', to: 'run:run-1', subject: 'B' })
      await deliverAndSubmit(delivery)
      expect(pointerTexts(writePty)).toHaveLength(1)

      await vi.advanceTimersByTimeAsync(11_000)

      expect(pointerTexts(writePty)).toHaveLength(2)
    } finally {
      db.close()
      vi.useRealTimers()
    }
  })
})
