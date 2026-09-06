/**
 * A slept recipient's mail must ask for a wake instead of going quiet.
 *
 * Every give-up point is covered: the pointer push finding no live pane at all
 * (the coordinator-slept-mid-run deadlock), a handle that still resolves to a
 * PTY-less leaf (what a listable slept pane looks like), and a pane that dies
 * between staging a pointer and submitting it. A live-but-busy pane still waits
 * for its idle edge — only "no process" counts as wake evidence.
 */
import { describe, expect, it, vi } from 'vitest'
import type { OrchestrationMailboxDeliveryTarget } from './mailbox-delivery-target'
import type { OrchestrationMailboxLeaf, OrchestrationMailboxOwner } from './mailbox-owner'
import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import { OrchestrationMailboxPointerState } from './mailbox-pointer-state'
import { submitOrchestrationMailboxPointer } from './mailbox-pointer-submit'
import type { OrchestrationDb } from './db'

const MAILBOX = 'run:run-1'

function liveLeaf(): OrchestrationMailboxLeaf {
  return {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    writable: true,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastOscTitle: null
  }
}

function makeDelivery(overrides: {
  resolveTerminalHandle: (handle: string) => string | null
  getLiveLeafForHandle?: (handle: string) => OrchestrationMailboxLeaf
}) {
  const requestSleepingRecipientWake = vi.fn()
  const delivery = new OrchestrationMailboxPointerDelivery({
    mailboxOwner: { resolve: () => null } as unknown as OrchestrationMailboxOwner,
    deliveryTarget: {
      resolveTerminalHandle: overrides.resolveTerminalHandle
    } as unknown as OrchestrationMailboxDeliveryTarget,
    getDb: () => null,
    getLeaf: () => undefined,
    getLeafKey: (tabId, leafId) => `${tabId}:${leafId}`,
    getLiveLeafForHandle:
      overrides.getLiveLeafForHandle ??
      (() => {
        throw new Error('no_active_terminal')
      }),
    getMessageWaiters: () => undefined,
    getTabTitle: () => null,
    getTerminalHandleForLeafKey: () => undefined,
    getTerminalProcessIncarnation: () => null,
    isLeafPtyProvenAbsent: () => Promise.resolve(false),
    redriveMailbox: () => undefined,
    requestSleepingRecipientWake,
    writePty: () => true
  })
  return { delivery, requestSleepingRecipientWake }
}

describe('mail delivery to a pane with no process', () => {
  it('requests a wake when no live pane owns the mailbox', () => {
    const { delivery, requestSleepingRecipientWake } = makeDelivery({
      resolveTerminalHandle: () => null
    })
    delivery.deliverForHandle(MAILBOX)
    expect(requestSleepingRecipientWake).toHaveBeenCalledWith(MAILBOX)
  })

  it('requests a wake when the owning handle no longer resolves to a live leaf', () => {
    const { delivery, requestSleepingRecipientWake } = makeDelivery({
      resolveTerminalHandle: () => 'term_stale'
    })
    delivery.deliverForHandle(MAILBOX)
    expect(requestSleepingRecipientWake).toHaveBeenCalledWith(MAILBOX)
  })

  it('requests a wake when the owning handle resolves to a leaf with no process', () => {
    // The exit that a listable slept pane takes: the handle still resolves and
    // the leaf still exists, so neither give-up branch above fires.
    const { delivery, requestSleepingRecipientWake } = makeDelivery({
      resolveTerminalHandle: () => 'term_slept',
      getLiveLeafForHandle: () => ({ ...liveLeaf(), ptyId: null, writable: false })
    })
    delivery.deliverForHandle(MAILBOX)
    expect(requestSleepingRecipientWake).toHaveBeenCalledWith(MAILBOX)
  })

  it('does not request a wake for a live pane that is merely busy', () => {
    const { delivery, requestSleepingRecipientWake } = makeDelivery({
      resolveTerminalHandle: () => 'term_busy',
      getLiveLeafForHandle: () => ({
        ...liveLeaf(),
        lastAgentStatus: 'working',
        lastAgentStatusObservedLive: true
      })
    })
    delivery.deliverForHandle(MAILBOX)
    expect(requestSleepingRecipientWake).not.toHaveBeenCalled()
  })

  it('does not request a wake while the recipient is live', () => {
    const { delivery, requestSleepingRecipientWake } = makeDelivery({
      resolveTerminalHandle: () => 'term_live',
      getLiveLeafForHandle: () => liveLeaf()
    })
    delivery.deliverForHandle(MAILBOX)
    expect(requestSleepingRecipientWake).not.toHaveBeenCalled()
  })

  it('requests a wake when the PTY is proven absent while a pointer is in flight', async () => {
    const requestSleepingRecipientWake = vi.fn()
    const markAsUndelivered = vi.fn()
    const state = new OrchestrationMailboxPointerState()
    const flight = state.beginFlight('pty-1')
    submitOrchestrationMailboxPointer(
      {
        mailboxOwner: { resolve: () => MAILBOX } as unknown as OrchestrationMailboxOwner,
        state,
        getDb: () => ({ markAsUndelivered }) as unknown as OrchestrationDb,
        getLeaf: () => undefined,
        getLeafKey: (tabId, leafId) => `${tabId}:${leafId}`,
        getTerminalProcessIncarnation: () => null,
        getMessageWaiters: () => undefined,
        isLeafPtyProvenAbsent: () => Promise.resolve(true),
        requestSleepingRecipientWake,
        writePty: () => true,
        settle: () => undefined,
        redrive: () => undefined
      },
      {
        leaf: liveLeaf(),
        mailboxHandle: MAILBOX,
        messages: [{ id: 'msg-1', type: 'worker_done' }],
        newestSequence: 1,
        ptyId: 'pty-1',
        flight
      }
    )
    await vi.waitFor(() => expect(markAsUndelivered).toHaveBeenCalled())
    expect(requestSleepingRecipientWake).toHaveBeenCalledWith(MAILBOX)
  })
})
