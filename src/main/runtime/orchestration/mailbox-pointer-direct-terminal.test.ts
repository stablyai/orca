import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationMailboxOwner, type OrchestrationMailboxLeaf } from './mailbox-owner'
import { OrchestrationMailboxPointerDelivery } from './mailbox-pointer-delivery'
import { WRITE_ACCEPTED, type WriteSettlement } from '../../../shared/pty-write-settlement'
import { sqliteFor } from '../orchestration-mailbox-notification-test-harness'

// A standalone terminal pane: no Run, no Dispatch, no remote attachment. Its own handle is its mailbox.
const TERMINAL = 'term-1'
const LEAF_KEY = 'tab-1:leaf-1'

function makeLeaf(overrides: Partial<OrchestrationMailboxLeaf> = {}): OrchestrationMailboxLeaf {
  return {
    tabId: 'tab-1',
    leafId: 'leaf-1',
    ptyId: 'pty-1',
    writable: true,
    lastAgentStatus: 'idle',
    lastAgentStatusObservedLive: true,
    lastOscTitle: null,
    ...overrides
  }
}

function harness(db: OrchestrationDb) {
  const live = {
    leaf: makeLeaf(),
    incarnation: 'inc-1',
    settled: true,
    terminalHandle: TERMINAL as string | undefined
  }
  const writes: string[] = []
  const settlementGate = vi.fn(() => live.settled)
  const owner = new OrchestrationMailboxOwner({
    getDb: () => db,
    getLeaf: () => live.leaf,
    getLeafKey: (tabId, leafId) => `${tabId}:${leafId}`,
    getTerminalHandleForLeafKey: () => live.terminalHandle,
    getTerminalProcessIncarnation: () => live.incarnation,
    onRoutedMessageTypes: () => {},
    onForeignMailboxRouted: () => {}
  })
  const redriven: string[] = []
  const delivery: OrchestrationMailboxPointerDelivery<never> =
    new OrchestrationMailboxPointerDelivery<never>({
      mailboxOwner: owner,
      deliveryTarget: { resolveTerminalHandle: () => TERMINAL, deferForAbsenceProbe: () => false },
      getDb: () => db,
      getLeaf: () => live.leaf,
      getLeafKey: (tabId: string, leafId: string) => `${tabId}:${leafId}`,
      getLiveLeafForHandle: () => live.leaf,
      isAgentSettledForDelivery: settlementGate,
      getMessageWaiters: () => undefined,
      getTabTitle: () => null,
      getCliCommand: () => 'orca' as const,
      getTerminalHandleForLeafKey: () => live.terminalHandle,
      resolveSubmitTarget: () =>
        live.terminalHandle
          ? {
              leaf: live.leaf,
              terminalHandle: live.terminalHandle,
              processIncarnation: live.incarnation
            }
          : null,
      isLeafPtyProvenAbsent: async () => false,
      redriveMailbox: (handle: string) => {
        redriven.push(handle)
      },
      writePty: (_ptyId: string, data: string): WriteSettlement => {
        writes.push(data)
        return WRITE_ACCEPTED
      }
    } as never)
  return { live, writes, settlementGate, owner, delivery, redriven }
}

describe('pointer delivery to a direct terminal mailbox', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    vi.useFakeTimers()
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  it('delivers the mailbox the owner resolves for a terminal-only pane, then settles it', async () => {
    const message = db.insertMessage({ from: 'coord', to: TERMINAL, subject: 'assignment' })
    const h = harness(db)
    const mailbox = h.owner.resolve(h.live.leaf)
    expect(mailbox).toBe(TERMINAL)

    h.delivery.deliver(h.live.leaf, { mailboxHandle: mailbox ?? '' })
    expect(h.settlementGate).toHaveBeenCalledTimes(1)
    expect(h.writes).toEqual([
      '\nYou have 1 orchestration message. Run `orca orchestration check`.\n'
    ])

    await vi.advanceTimersByTimeAsync(600)
    expect(h.writes.slice(1)).toEqual(['\r'])
    // Delivery is only the nudge: the agent must still acknowledge by reading.
    expect(db.getMessageById(message.id)).toMatchObject({ pointer_enter_pending: 0, read: 0 })
    expect(db.getMessageById(message.id)?.delivered_at).not.toBeNull()
  })

  it('still refuses a plain handle that is not this leaf’s own terminal', () => {
    db.insertMessage({ from: 'coord', to: 'term-2', subject: 'not yours' })
    const h = harness(db)
    h.delivery.deliver(h.live.leaf, { mailboxHandle: 'term-2' })
    expect(h.settlementGate).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
  })

  it('refuses the bare terminal handle while the pane owns a Run', () => {
    const run = db.createRun({
      objective: 'coordinate',
      coordinatorHandle: TERMINAL,
      coordinatorPaneKey: LEAF_KEY
    })
    expect(db.getCurrentRunForPane?.(LEAF_KEY)?.id).toBe(run.id)
    db.insertMessage({ from: 'peer', to: TERMINAL, subject: 'direct' })
    const h = harness(db)
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    expect(h.settlementGate).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
  })

  it('refuses when the leaf has no live terminal identity', () => {
    db.insertMessage({ from: 'coord', to: TERMINAL, subject: 'assignment' })
    const h = harness(db)
    h.live.terminalHandle = undefined
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    expect(h.settlementGate).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
  })

  it('parks behind the settlement gate (e.g. a pending permission prompt) and writes nothing', () => {
    db.insertMessage({ from: 'coord', to: TERMINAL, subject: 'assignment' })
    const h = harness(db)
    h.live.settled = false
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    expect(h.settlementGate).toHaveBeenCalledTimes(1)
    expect(h.writes).toEqual([])

    h.live.settled = true
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    expect(h.writes).toHaveLength(1)
  })

  it('types one pointer for repeated delivery events during a flight', async () => {
    db.insertMessage({ from: 'coord', to: TERMINAL, subject: 'first' })
    const h = harness(db)
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    h.delivery.deliverForHandle(TERMINAL)
    expect(h.writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(600)
    expect(h.writes.filter((write) => write === '\r')).toHaveLength(1)
  })

  it('does not replay mail the agent already read', () => {
    const message = db.insertMessage({ from: 'coord', to: TERMINAL, subject: 'done' })
    db.markAsRead([message.id])
    const h = harness(db)
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    expect(h.writes).toEqual([])
  })

  it('withholds Enter and releases the reservation when the process incarnation changes', async () => {
    const message = db.insertMessage({ from: 'coord', to: TERMINAL, subject: 'assignment' })
    const h = harness(db)
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    expect(h.writes).toHaveLength(1)

    // The terminal restarted between the pointer write and the Enter.
    h.live.incarnation = 'inc-2'
    await vi.advanceTimersByTimeAsync(600)
    expect(h.writes).not.toContain('\r')
    expect(db.getMessageById(message.id)).toMatchObject({
      pointer_enter_pending: 0,
      read: 0,
      delivered_at: null
    })
  })

  it('leaves Run and Dispatch mailboxes on their existing path', () => {
    db.insertMessage({ from: 'a', to: 'run:run-x', subject: 'run' })
    const h = harness(db)
    h.live.settled = false
    h.delivery.deliver(h.live.leaf, { mailboxHandle: 'run:run-x' })
    h.delivery.deliver(h.live.leaf, { mailboxHandle: 'dispatch:d-x' })
    expect(h.settlementGate).toHaveBeenCalledTimes(2)
    expect(h.writes).toEqual([])
  })
})

describe('direct terminal pointers and Run ownership', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    vi.useFakeTimers()
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => {
    db.close()
    vi.useRealTimers()
  })

  // This terminal once coordinated the Run, which now belongs to another pane: routing owes it there.
  function runOwnedElsewhere(): string {
    const run = db.createRun({
      objective: 'moved',
      coordinatorHandle: TERMINAL,
      coordinatorPaneKey: LEAF_KEY
    })
    db.bindRun({
      runId: run.id,
      coordinatorHandle: 'term-other',
      coordinatorPaneKey: 'tab-9:leaf-9'
    })
    expect(db.getCurrentRunForPane(LEAF_KEY)).toBeUndefined()
    return run.id
  }

  // Insert-time triggers already route such mail; a row persisted before them still sits on the terminal.
  function insertOwnedDirectRow(runId: string, subject: string) {
    const message = db.insertMessage({ runId, from: 'peer', to: TERMINAL, subject })
    sqliteFor(db)
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(TERMINAL, message.id)
    return message
  }

  function coordinatorRun(): string {
    return db.createRun({
      objective: 'peer',
      coordinatorHandle: 'term-coord',
      coordinatorPaneKey: 'tab-c:leaf-c'
    }).id
  }

  function dispatchTerminalInto(runId: string): string {
    return db.createDispatchContext({
      taskId: db.createTask({ runId, spec: 'work' }).id,
      assigneeHandle: TERMINAL,
      assigneePaneKey: LEAF_KEY,
      creator: { kind: 'system' },
      maxDepth: 100
    }).id
  }

  it('delivers direct mail sent from another Run to a terminal that holds no part in it', async () => {
    const message = db.insertMessage({
      runId: coordinatorRun(),
      from: 'term-coord',
      to: TERMINAL,
      subject: 'status'
    })
    const h = harness(db)
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    expect(h.writes).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(600)
    expect(h.writes.slice(1)).toEqual(['\r'])
    expect(db.getMessageById(message.id)?.delivered_at).not.toBeNull()
  })

  it('points only unowned rows and leaves a Run-owned row routable to its owner', async () => {
    const ownerRunId = runOwnedElsewhere()
    const owned = insertOwnedDirectRow(ownerRunId, 'a')
    const unowned = db.insertMessage({ from: 'coord', to: TERMINAL, subject: 'b' })
    const h = harness(db)
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    expect(h.writes).toEqual([
      '\nYou have 1 orchestration message. Run `orca orchestration check`.\n'
    ])
    await vi.advanceTimersByTimeAsync(600)

    expect(db.getMessageById(unowned.id)?.delivered_at).not.toBeNull()
    expect(db.getMessageById(owned.id)).toMatchObject({
      to_handle: TERMINAL,
      read: 0,
      delivered_at: null,
      pointer_enter_pending: 0
    })
    const routed = db.routeForeignDirectMessagesToOwnedMailboxes(TERMINAL, undefined, LEAF_KEY)
    expect(routed.mailboxes.map((mailbox) => mailbox.mailboxHandle)).toEqual([`run:${ownerRunId}`])
    expect(db.getMessageById(owned.id)?.to_handle).toBe(`run:${ownerRunId}`)
  })

  it('types nothing when every unread row is Run-owned', () => {
    const owned = insertOwnedDirectRow(runOwnedElsewhere(), 'a')
    const h = harness(db)
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    expect(h.writes).toEqual([])
    expect(db.getMessageById(owned.id)).toMatchObject({
      delivered_at: null,
      pointer_enter_pending: 0
    })
  })

  it('refuses the terminal mailbox while a pending Dispatch owns the pane', () => {
    const runId = coordinatorRun()
    const dispatchId = dispatchTerminalInto(runId)
    const message = db.insertMessage({ runId, from: 'term-coord', to: TERMINAL, subject: 'task' })
    const h = harness(db)
    expect(h.owner.resolve(h.live.leaf, undefined, { routeDirectMail: false })).toBe(
      `dispatch:${dispatchId}`
    )
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    expect(h.settlementGate).not.toHaveBeenCalled()
    expect(h.writes).toEqual([])
    expect(db.getMessageById(message.id)).toMatchObject({
      delivered_at: null,
      pointer_enter_pending: 0
    })
  })

  it('withholds Enter and releases the row when a Dispatch takes the pane before submit', async () => {
    const runId = coordinatorRun()
    const message = db.insertMessage({ runId, from: 'term-coord', to: TERMINAL, subject: 'status' })
    const h = harness(db)
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    expect(h.writes).toHaveLength(1)

    const dispatchId = dispatchTerminalInto(runId)
    await vi.advanceTimersByTimeAsync(600)
    expect(h.writes).not.toContain('\r')
    expect(db.getMessageById(message.id)).toMatchObject({
      read: 0,
      delivered_at: null,
      pointer_enter_pending: 0
    })
    // Released, so the new owner's routing can still take it.
    db.routeForeignDirectMessagesToOwnedMailboxes(TERMINAL, undefined, LEAF_KEY)
    expect(db.getMessageById(message.id)?.to_handle).toBe(`dispatch:${dispatchId}`)
  })

  it('does not point a delivered row again on later idle edges', async () => {
    db.insertMessage({ runId: coordinatorRun(), from: 'term-coord', to: TERMINAL, subject: 's' })
    const h = harness(db)
    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    await vi.advanceTimersByTimeAsync(600)
    expect(h.writes).toHaveLength(2)

    h.delivery.deliver(h.live.leaf, { mailboxHandle: TERMINAL })
    h.delivery.deliverForHandle(TERMINAL)
    await vi.advanceTimersByTimeAsync(600)
    expect(h.writes).toHaveLength(2)
  })
})
