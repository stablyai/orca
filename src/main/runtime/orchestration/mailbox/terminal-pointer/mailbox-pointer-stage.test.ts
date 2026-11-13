import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'
import { stageOrchestrationMailboxPointer } from './mailbox-pointer-stage'
import {
  WRITE_ACCEPTED,
  writeRefused,
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
    // Hold the pane settled to isolate staging and Enter phases from the idle gate.
    isAgentSettledForDelivery: () => true,
    getMessageWaiters: () => undefined,
    getCliCommand: () => 'orca' as const,
    resolveSubmitTarget: () => ({ terminal: TERMINAL, processIncarnation: 'inc-1' }),
    readForeground: async () => 'unknown' as const,
    redriveTerminal: vi.fn(),
    onDeliveryDecision: vi.fn(),
    isLeafPtyProvenAbsent: async () => false,
    isPtyAwaitingUserInput: () => false,
    redriveMailbox: vi.fn(),
    writePty
  }
}

function stageArgs(db: OrchestrationDb, state: OrchestrationMailboxPointerState) {
  return {
    deps: pointerDeps(db, () => WRITE_ACCEPTED),
    state,
    terminal: TERMINAL,
    mailboxHandle: 'run:run-1',
    newestSequence: 1,
    enterDelayMs: 5,
    settle: (ptyId: string, flight: never) => state.settleFlight(ptyId, flight),
    redrive: vi.fn()
  }
}

describe('mailbox pointer staging watermark', () => {
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
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: only Reflect.get forwards a raw string|symbol key with the proxy receiver.
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })

    const writePty = vi.fn(() => WRITE_ACCEPTED)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies only the deps delivery reads.
    const delivery = new OrchestrationMailboxPointerDelivery<never>({
      ...pointerDeps(contended, writePty),
      redriveMailbox: (handle: string) => delivery.deliver(TERMINAL, { mailboxHandle: handle })
    } as never)

    delivery.deliver(TERMINAL, { mailboxHandle: 'run:run-1', skipAbsenceProbe: true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(writePty).not.toHaveBeenCalled()

    db.insertMessage({ runId: 'run_legacy_local', from: 'a', to: 'run:run-1', subject: 'second' })
    delivery.deliver(TERMINAL, { mailboxHandle: 'run:run-1', skipAbsenceProbe: true })
    await new Promise((resolve) => setImmediate(resolve))

    expect(writePty.mock.calls.length).toBeGreaterThan(0)
    db.close()
  })
})

describe('retiring a pty mid-delivery', () => {
  // Only provably unsubmitted phases may retry; an attempted Enter may already have landed.
  it('leaves an attempted Enter at its phase instead of making it redeliverable', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const settlements: ((settlement: WriteSettlement) => void)[] = []
    const writePty = vi.fn(
      () =>
        new Promise<WriteSettlement>((resolve) => {
          settlements.push(resolve)
        }) as unknown as WriteSettlement
    )
    try {
      const message = db.insertMessage({ from: 'a', to: 'run:run-1', subject: 'mail' })
      const delivery = new OrchestrationMailboxPointerDelivery(pointerDeps(db, writePty) as never)
      delivery.deliver(TERMINAL, { mailboxHandle: 'run:run-1' })
      await vi.advanceTimersByTimeAsync(0)

      settlements[0]?.(WRITE_ACCEPTED)
      await vi.advanceTimersByTimeAsync(0)
      expect(db.getMessageById(message.id)?.pointer_enter_pending).toBe(2)

      // Attempt Enter without settling it to create an ambiguous handoff.
      await vi.advanceTimersByTimeAsync(600)
      expect(db.getMessageById(message.id)?.pointer_enter_pending).toBe(3)

      delivery.retirePty('pty-1')
      expect(db.getMessageById(message.id)).toMatchObject({
        pointer_enter_pending: 3,
        read: 0
      })
    } finally {
      db.close()
      vi.useRealTimers()
    }
  })

  it('preserves staged and parked obligations when an obsolete hold is queried before retirement', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const writePty = vi.fn(() => WRITE_ACCEPTED)
    let incarnation = 'inc-1'
    let resolveOldAbsence: (() => void) | undefined
    let firstAbsence = true
    const deps = {
      ...pointerDeps(db, writePty),
      mailboxOwner: { resolve: (_terminal: unknown, handle?: string) => handle ?? null },
      isLeafPtyProvenAbsent: () => {
        if (firstAbsence) {
          firstAbsence = false
          return new Promise<boolean>((resolve) => {
            resolveOldAbsence = () => resolve(false)
          })
        }
        return Promise.resolve(false)
      },
      resolveSubmitTarget: () => ({ terminal: TERMINAL, processIncarnation: incarnation })
    }
    const delivery = new OrchestrationMailboxPointerDelivery(deps)
    try {
      const first = db.insertMessage({ from: 'a', to: 'run:run-1', subject: 'staged' })
      const second = db.insertMessage({ from: 'a', to: 'run:run-2', subject: 'parked' })
      delivery.deliver(TERMINAL, { mailboxHandle: 'run:run-1' })
      await vi.advanceTimersByTimeAsync(0)
      delivery.deliver(TERMINAL, { mailboxHandle: 'run:run-2' })
      expect(writePty).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(500)
      expect(resolveOldAbsence).toBeTypeOf('function')
      const proof = delivery.captureForegroundObservation('pty-1')
      delivery.applyForeground('pty-1', proof, 'shell')
      incarnation = 'inc-2'
      expect(delivery.isForegroundHeld('pty-1')).toBe(false)
      delivery.retirePty('pty-1')
      expect(db.getMessageById(first.id)).toMatchObject({
        read: 0,
        delivered_at: null,
        pointer_enter_pending: 0
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(deps.redriveMailbox).toHaveBeenCalledWith('run:run-1', undefined)
      expect(deps.redriveMailbox).toHaveBeenCalledWith('run:run-2', undefined)
      delivery.deliver(TERMINAL, { mailboxHandle: 'run:run-2' })
      await vi.advanceTimersByTimeAsync(0)
      resolveOldAbsence?.()
      await vi.advanceTimersByTimeAsync(1000)
      expect(writePty).toHaveBeenCalledTimes(3)
      expect(db.getMessageById(second.id)).toMatchObject({
        read: 0,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
      expect(db.getMessageById(first.id)?.pointer_enter_pending).toBe(0)
    } finally {
      delivery.retirePty('pty-1')
      db.close()
      vi.useRealTimers()
    }
  })

  it('releases a pointer whose Enter never fired', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const settlements: ((settlement: WriteSettlement) => void)[] = []
    const writePty = vi.fn(
      () =>
        new Promise<WriteSettlement>((resolve) => {
          settlements.push(resolve)
        }) as unknown as WriteSettlement
    )
    try {
      const message = db.insertMessage({ from: 'a', to: 'run:run-1', subject: 'mail' })
      const delivery = new OrchestrationMailboxPointerDelivery(pointerDeps(db, writePty) as never)
      delivery.deliver(TERMINAL, { mailboxHandle: 'run:run-1' })
      await vi.advanceTimersByTimeAsync(0)
      settlements[0]?.(WRITE_ACCEPTED)
      await vi.advanceTimersByTimeAsync(0)
      expect(db.getMessageById(message.id)?.pointer_enter_pending).toBe(2)

      delivery.retirePty('pty-1')
      expect(db.getMessageById(message.id)).toMatchObject({
        pointer_enter_pending: 0,
        read: 0,
        delivered_at: null
      })
    } finally {
      db.close()
      vi.useRealTimers()
    }
  })
})
