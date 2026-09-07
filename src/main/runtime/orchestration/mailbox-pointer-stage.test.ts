import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'
import { stageOrchestrationMailboxPointer } from './mailbox-pointer-stage'
import {
  WRITE_ACCEPTED,
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

function pointerDeps(db: OrchestrationDb, writePty: () => WriteSettlement) {
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
  it('leaves no watermark when the reservation claim is lost', () => {
    const db = new OrchestrationDb(':memory:')
    const message = db.insertMessage({ from: 'a', to: 'run:run-1', subject: 's' })
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
    const message = db.insertMessage({ from: 'a', to: 'run:run-1', subject: 's' })
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
    const message = db.insertMessage({ from: 'a', to: 'run:run-1', subject: 's' })
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
    const message = db.insertMessage({ from: 'a', to: 'run:run-1', subject: 's' })
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
    db.insertMessage({ from: 'a', to: 'run:run-1', subject: 'first' })
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
    db.insertMessage({ from: 'a', to: 'run:run-1', subject: 'second' })
    delivery.deliver(LEAF, { mailboxHandle: 'run:run-1', skipAbsenceProbe: true })
    await new Promise((resolve) => setImmediate(resolve))

    expect(writePty.mock.calls.length).toBeGreaterThan(0)
    db.close()
  })
})
