import { afterEach, describe, expect, it, vi } from 'vitest'
import { WRITE_ACCEPTED } from '../../../shared/pty-write-settlement'
import { OrchestrationDb } from './db'
import { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'
import { OrchestrationMailboxOwner, type OrchestrationMailboxLeaf } from './mailbox-owner'
import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'

function createDelivery(db: OrchestrationDb) {
  const leaf: OrchestrationMailboxLeaf = {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    writable: true,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastOscTitle: null
  }
  const isAgentSettledForDelivery = vi.fn(() => false)
  const writePty = vi.fn(() => WRITE_ACCEPTED)
  const mailboxOwner = new OrchestrationMailboxOwner({
    getDb: () => db,
    getLeaf: () => leaf,
    getLeafKey: () => 'tab-1:leaf-1',
    getTerminalHandleForLeafKey: () => 'term-1',
    getTerminalProcessIncarnation: () => 'inc-1',
    onRoutedMessageTypes: () => {},
    onForeignMailboxRouted: () => {}
  })
  const deliveryTarget = new OrchestrationMailboxDeliveryTarget({
    getDb: () => db,
    getTerminalHandleForPaneKey: () => 'term-1',
    hasTerminalHandle: () => true,
    isStructuredWorkerHandle: () => false,
    canProbePtyLiveness: () => false,
    controllerKnowsPtyIsLive: () => true,
    isLeafPtyProvenAbsent: async () => false
  })
  const delivery = new OrchestrationMailboxPointerDelivery({
    mailboxOwner,
    deliveryTarget,
    getDb: () => db,
    getLeaf: () => leaf,
    getLeafKey: () => 'tab-1:leaf-1',
    getLiveLeafForHandle: () => leaf,
    isAgentSettledForDelivery,
    getMessageWaiters: () => undefined,
    getTabTitle: () => null,
    getCliCommand: () => 'orca',
    getTerminalHandleForLeafKey: () => 'term-1',
    resolveSubmitTarget: () => ({ leaf, terminalHandle: 'term-1', processIncarnation: 'inc-1' }),
    isLeafPtyProvenAbsent: async () => false,
    redriveMailbox: () => {},
    writePty
  })
  return { delivery, leaf, isAgentSettledForDelivery, writePty }
}

describe('mailbox pointer idle retry retention', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('does not retain retired mailboxes that never started a pointer flight', () => {
    const db = new OrchestrationDb(':memory:')
    const { delivery, leaf } = createDelivery(db)
    const states = new Set<OrchestrationMailboxPointerState>()
    const retire = OrchestrationMailboxPointerState.prototype.retirePty
    vi.spyOn(OrchestrationMailboxPointerState.prototype, 'retirePty').mockImplementation(function (
      this: OrchestrationMailboxPointerState,
      ptyId: string
    ) {
      states.add(this)
      return retire.call(this, ptyId)
    })
    const mailboxes: string[] = []
    try {
      for (let cycle = 0; cycle < 40; cycle += 1) {
        const run = db.createRun({
          objective: `Retired coordinator ${cycle}`,
          coordinatorHandle: 'term-1',
          coordinatorPaneKey: 'tab-1:leaf-1'
        })
        const mailbox = `run:${run.id}`
        mailboxes.push(mailbox)
        leaf.ptyId = `pty-${cycle}`
        delivery.deliver(leaf, { mailboxHandle: mailbox, reservedTypes: new Set(['question']) })
        delivery.retirePty(leaf.ptyId)
      }
      const retained = [...states].flatMap((state) =>
        mailboxes.filter((mailbox) => state.takeRedelivery(mailbox, false) !== undefined)
      )
      expect(retained).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('delivers durable unread mail when the existing idle recheck retries', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const { delivery, leaf, isAgentSettledForDelivery, writePty } = createDelivery(db)
    const run = db.createRun({
      objective: 'Retry once the agent settles',
      coordinatorHandle: 'term-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const mailboxHandle = `run:${run.id}`
    const message = db.insertMessage({ from: 'worker', to: mailboxHandle, subject: 'Ready' })
    try {
      delivery.deliver(leaf, { mailboxHandle })
      expect(writePty).not.toHaveBeenCalled()
      expect(db.getMessageById(message.id)?.read).toBe(0)

      isAgentSettledForDelivery.mockReturnValue(true)
      delivery.deliver(leaf, { mailboxHandle })
      await vi.advanceTimersByTimeAsync(500)

      expect(writePty).toHaveBeenCalledTimes(2)
      expect(writePty).toHaveBeenLastCalledWith('pty-1', '\r')
      expect(db.getMessageById(message.id)).toMatchObject({ pointer_enter_pending: 0, read: 0 })
    } finally {
      delivery.retirePty('pty-1')
      db.close()
    }
  })
})
