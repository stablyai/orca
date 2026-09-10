import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'
import { stageOrchestrationMailboxPointer } from './mailbox-pointer-stage'
import {
  WRITE_ACCEPTED,
  writeUnverifiable,
  writeRefused,
  type WriteSettlement
} from '../../../shared/pty-write-settlement'

const LEAF = {
  tabId: 'tab-1',
  leafId: 'leaf-1',
  ptyId: 'pty-1',
  writable: true,
  lastAgentStatus: 'idle' as const,
  lastAgentStatusObservedLive: true,
  lastOscTitle: null
}

function pointerDeps(
  db: OrchestrationDb,
  writePty: () => WriteSettlement | Promise<WriteSettlement>
) {
  return {
    mailboxOwner: { resolve: () => 'run:run-1' },
    deliveryTarget: { resolveTerminalHandle: () => 'term-1', deferForAbsenceProbe: () => false },
    getDb: () => db,
    getLeaf: () => LEAF,
    getLeafKey: () => 'tab-1:leaf-1',
    getLiveLeafForHandle: () => LEAF,
    getMessageWaiters: () => undefined,
    getTabTitle: () => null,
    getCliCommand: () => 'orca' as const,
    getTerminalHandleForLeafKey: () => 'term-1',
    resolveSubmitTarget: () => ({
      leaf: LEAF,
      terminalHandle: 'term-1',
      processIncarnation: 'inc-1'
    }),
    isLeafPtyProvenAbsent: async () => false,
    redriveMailbox: vi.fn(),
    writePty
  }
}

function stageArgs(db: OrchestrationDb, state: OrchestrationMailboxPointerState) {
  return {
    deps: pointerDeps(db, () => WRITE_ACCEPTED),
    state,
    leaf: LEAF,
    mailboxHandle: 'run:run-1',
    newestSequence: 1,
    enterDelayMs: 5,
    leafKey: 'tab-1:leaf-1',
    settle: (ptyId: string, flight: never) => state.settleFlight(ptyId, flight),
    redrive: vi.fn()
  }
}

describe('mailbox pointer staging watermark', () => {
  it('reconciles an uncertain Enter from working evidence retained by its flight', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    let finish!: (settlement: WriteSettlement) => void
    const writePty = vi
      .fn<() => WriteSettlement | Promise<WriteSettlement>>()
      .mockReturnValueOnce(WRITE_ACCEPTED)
      .mockImplementationOnce(
        () =>
          new Promise<WriteSettlement>((resolve) => {
            finish = resolve
          })
      )
    const delivery = new OrchestrationMailboxPointerDelivery(pointerDeps(db, writePty) as never)
    try {
      const message = db.insertMessage({ from: 'a', to: 'run:run-1', subject: 'mail' })
      delivery.deliver(LEAF, { mailboxHandle: 'run:run-1' })
      await vi.advanceTimersByTimeAsync(1000)
      delivery.observeAgentWorking('pty-1')
      expect(db.getMessageById(message.id)?.pointer_enter_pending).toBe(3)
      finish(writeUnverifiable('transport_settlement_lost', true))
      await vi.advanceTimersByTimeAsync(0)
      expect(db.getMessageById(message.id)).toMatchObject({
        pointer_enter_pending: 0,
        read: 0,
        delivered_at: expect.any(String)
      })
      expect(writePty).toHaveBeenCalledTimes(2)
    } finally {
      delivery.retirePty('pty-1')
      db.close()
      vi.useRealTimers()
    }
  })
  it.each(['accepted', 'unverifiable'] as const)(
    'fences %s Enter settlement after database replacement',
    async (outcome) => {
      vi.useFakeTimers()
      const original = new OrchestrationDb(':memory:')
      const replacement = new OrchestrationDb(':memory:')
      let current = original
      let finish!: (settlement: WriteSettlement) => void
      const writePty = vi
        .fn<() => WriteSettlement | Promise<WriteSettlement>>()
        .mockReturnValueOnce(WRITE_ACCEPTED)
        .mockImplementationOnce(
          () =>
            new Promise<WriteSettlement>((resolve) => {
              finish = resolve
            })
        )
      const delivery = new OrchestrationMailboxPointerDelivery({
        ...pointerDeps(original, writePty),
        getDb: () => current
      } as never)
      try {
        const old = original.insertMessage({ from: 'a', to: 'run:run-1', subject: 'old' })
        const message = replacement.insertMessage({ from: 'a', to: 'run:run-1', subject: 'new' })
        replacement.stageMailboxPointerEnter([message.id], {
          ptyId: 'pty-1',
          processIncarnation: 'inc-1'
        })
        delivery.deliver(LEAF, { mailboxHandle: 'run:run-1' })
        await vi.advanceTimersByTimeAsync(1000)
        expect(original.getMessageById(old.id)?.pointer_enter_pending).toBe(3)
        delivery.observeAgentWorking('pty-1')
        current = replacement
        const prepare = vi.spyOn(replacement.db, 'prepare')
        finish(
          outcome === 'accepted'
            ? WRITE_ACCEPTED
            : writeUnverifiable('transport_settlement_lost', true)
        )
        await vi.advanceTimersByTimeAsync(0)
        expect(prepare).not.toHaveBeenCalled()
        prepare.mockRestore()
        delivery.observeAgentWorking('pty-1')
        expect(replacement.getMessageById(message.id)?.pointer_enter_pending).toBe(0)
        expect(writePty).toHaveBeenCalledTimes(2)
      } finally {
        delivery.retirePty('pty-1')
        original.close()
        replacement.close()
        vi.useRealTimers()
      }
    }
  )
  it('reconciles working observed during an uncertain paste without another title', async () => {
    const db = new OrchestrationDb(':memory:')
    let finish!: (settlement: WriteSettlement) => void
    const writePty = vi.fn(
      () =>
        new Promise<WriteSettlement>((resolve) => {
          finish = resolve
        })
    )
    const delivery = new OrchestrationMailboxPointerDelivery(pointerDeps(db, writePty) as never)
    try {
      const message = db.insertMessage({ from: 'a', to: 'run:run-1', subject: 'first' })
      delivery.deliver(LEAF, { mailboxHandle: 'run:run-1' })
      delivery.observeAgentWorking('pty-1')
      expect(db.getMessageById(message.id)?.pointer_enter_pending).toBe(2)
      finish(writeUnverifiable('transport_settlement_lost', true))
      await new Promise((resolve) => setImmediate(resolve))
      expect(db.getMessageById(message.id)).toMatchObject({
        pointer_enter_pending: 0,
        read: 0,
        delivered_at: expect.any(String)
      })
      expect(writePty).toHaveBeenCalledTimes(1)
      delivery.observeAgentWorking('pty-1')
      const prepare = vi.spyOn(db.db, 'prepare')
      for (let i = 0; i < 5000; i++) {
        delivery.observeAgentWorking(`inactive-${i}`)
      }
      // A pane holding no reservation reads the partial index and must never write.
      expect(
        prepare.mock.calls
          .map(([sql]) => String(sql).trimStart().toUpperCase())
          .filter((sql) => !sql.startsWith('SELECT'))
      ).toEqual([])
    } finally {
      delivery.retirePty('pty-1')
      db.close()
    }
  })

  it('recovers a reservation created after an earlier same-status observation', () => {
    const db = new OrchestrationDb(':memory:')
    const delivery = new OrchestrationMailboxPointerDelivery(
      pointerDeps(db, () => WRITE_ACCEPTED) as never
    )
    try {
      delivery.observeAgentWorking('pty-1')
      const message = db.insertMessage({ from: 'a', to: 'run:run-1', subject: 'mail' })
      db.stageMailboxPointerEnter([message.id], { ptyId: 'pty-1', processIncarnation: 'inc-1' })
      delivery.observeAgentWorking('pty-1')
      expect(db.getMessageById(message.id)).toMatchObject({
        pointer_enter_pending: 0,
        delivered_at: null,
        read: 0
      })
    } finally {
      db.close()
    }
  })

  it.each(['accepted', 'unverifiable'] as const)(
    'retires a %s paste flight across database replacement',
    async (outcome) => {
      const original = new OrchestrationDb(':memory:')
      const replacement = new OrchestrationDb(':memory:')
      let current = original
      let finish!: (settlement: WriteSettlement) => void
      const writePty = vi.fn(
        () =>
          new Promise<WriteSettlement>((resolve) => {
            finish = resolve
          })
      )
      const delivery = new OrchestrationMailboxPointerDelivery({
        ...pointerDeps(original, writePty),
        getDb: () => current
      } as never)
      try {
        original.insertMessage({ from: 'a', to: 'run:run-1', subject: 'old' })
        const message = replacement.insertMessage({ from: 'a', to: 'run:run-1', subject: 'new' })
        replacement.stageMailboxPointerEnter([message.id], {
          ptyId: 'pty-1',
          processIncarnation: 'inc-1'
        })
        delivery.deliver(LEAF, { mailboxHandle: 'run:run-1' })
        delivery.observeAgentWorking('pty-1')
        current = replacement
        const prepare = vi.spyOn(replacement.db, 'prepare')
        finish(
          outcome === 'accepted'
            ? WRITE_ACCEPTED
            : writeUnverifiable('transport_settlement_lost', true)
        )
        await new Promise((resolve) => setImmediate(resolve))
        expect(prepare).not.toHaveBeenCalled()
        prepare.mockRestore()
        expect(replacement.getMessageById(message.id)?.pointer_enter_pending).toBe(1)
        delivery.observeAgentWorking('pty-1')
        expect(replacement.getMessageById(message.id)?.pointer_enter_pending).toBe(0)
        expect(writePty).toHaveBeenCalledTimes(1)
      } finally {
        delivery.retirePty('pty-1')
        original.close()
        replacement.close()
      }
    }
  )
  it('leaves no watermark when the reservation claim is lost', () => {
    const db = new OrchestrationDb(':memory:')
    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 's'
    })
    // A concurrent flight already owns the reservation, so this claim cannot succeed.
    expect(
      db.stageMailboxPointerEnter([message.id], { ptyId: 'other-pty', processIncarnation: 'inc-x' })
    ).toBe(true)

    const state = new OrchestrationMailboxPointerState()
    const args = stageArgs(db, state)
    stageOrchestrationMailboxPointer({
      ...args,
      messages: [{ id: message.id, type: 'status', sequence: 1 }]
    } as never)

    expect(state.hasActiveWatermark('run:run-1')).toBe(false)
    expect(state.hasFlight('pty-1')).toBe(false)
    db.close()
  })

  it('leaves no watermark when the reservation write throws', () => {
    const db = new OrchestrationDb(':memory:')
    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 's'
    })
    const throwing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'markMailboxPointerWriteAttempted') {
          return () => {
            throw new Error('SQLITE_BUSY')
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as OrchestrationDb

    const state = new OrchestrationMailboxPointerState()
    const args = stageArgs(db, state)
    stageOrchestrationMailboxPointer({
      ...args,
      deps: { ...args.deps, getDb: () => throwing },
      messages: [{ id: message.id, type: 'status', sequence: 1 }]
    } as never)

    expect(state.hasActiveWatermark('run:run-1')).toBe(false)
    expect(state.hasFlight('pty-1')).toBe(false)
    db.close()
  })

  it('keeps the watermark for the flight that owns the reservation', () => {
    const db = new OrchestrationDb(':memory:')
    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 's'
    })
    const state = new OrchestrationMailboxPointerState()
    const args = stageArgs(db, state)
    stageOrchestrationMailboxPointer({
      ...args,
      deps: { ...args.deps, writePty: () => WRITE_ACCEPTED },
      messages: [{ id: message.id, type: 'status', sequence: 1 }]
    } as never)

    expect(state.hasActiveWatermark('run:run-1')).toBe(true)
    db.close()
  })

  it('drains a delivery parked behind the watermark when the write is refused', () => {
    const db = new OrchestrationDb(':memory:')
    const message = db.insertMessage({
      runId: 'run_legacy_local',
      from: 'a',
      to: 'run:run-1',
      subject: 's'
    })
    const state = new OrchestrationMailboxPointerState()
    const args = stageArgs(db, state)
    const redrive = vi.fn()
    stageOrchestrationMailboxPointer({
      ...args,
      redrive,
      deps: {
        ...args.deps,
        writePty: () => {
          // A concurrent delivery arrives while this flight owns the watermark.
          state.parkRedelivery('run:run-1')
          return writeRefused('provider_refused_write')
        }
      },
      messages: [{ id: message.id, type: 'status', sequence: 1 }]
    } as never)

    expect(redrive).toHaveBeenCalledWith('run:run-1')
    expect(state.hasActiveWatermark('run:run-1')).toBe(false)
    expect(db.getMessageById(message.id)?.pointer_enter_pending).toBe(0)
    db.close()
  })

  it('still points new mail after a delivery lost its reservation claim', async () => {
    const db = new OrchestrationDb(':memory:')
    db.insertMessage({ runId: 'run_legacy_local', from: 'a', to: 'run:run-1', subject: 'first' })
    let stealNextClaim = true
    const contended = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'stageMailboxPointerEnter' && stealNextClaim) {
          stealNextClaim = false
          return () => false
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as OrchestrationDb

    const writePty = vi.fn(() => WRITE_ACCEPTED)
    const delivery = new OrchestrationMailboxPointerDelivery<never>({
      ...pointerDeps(contended, writePty),
      redriveMailbox: (handle: string) => delivery.deliver(LEAF, { mailboxHandle: handle })
    } as never)

    delivery.deliver(LEAF, { mailboxHandle: 'run:run-1', skipAbsenceProbe: true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(writePty).not.toHaveBeenCalled()

    // Newer mail must still reach the agent; a leaked watermark used to park it forever.
    db.insertMessage({ runId: 'run_legacy_local', from: 'a', to: 'run:run-1', subject: 'second' })
    delivery.deliver(LEAF, { mailboxHandle: 'run:run-1', skipAbsenceProbe: true })
    await new Promise((resolve) => setImmediate(resolve))

    expect(writePty.mock.calls.length).toBeGreaterThan(0)
    db.close()
  })
})
