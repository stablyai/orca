// The startup pass's second phase: after reconcile, what a restart left owed is settled for every
// listed chat and every open conversation, one chat at a time, without holding any reader behind
// more than the chat in progress, and without leaving open what only the pass wanted open.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION } from '../../../shared/structured-agent-session-saved-status'
import { probeJournalCursor } from '../agent-session-journal/journal-cursor-probe'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import {
  createStartupRig,
  isOpen,
  type StartupRig
} from './structured-agent-session-startup-pass-test-rig'

let rig: StartupRig

beforeEach(async () => {
  rig = await createStartupRig()
})

afterEach(async () => {
  await rig.dispose()
})

/** Holds every journal open while `holding`, releasable one session at a time. */
function gateOpens() {
  const held = new Map<string, () => void>()
  const gate = { holding: true, held, release: (sessionId: string) => held.get(sessionId)?.() }
  rig.historyFilePath.mockImplementation(async (sessionId) => {
    if (gate.holding) {
      const opened = Promise.withResolvers<void>()
      held.set(sessionId, opened.resolve)
      await opened.promise
    }
    return null
  })
  return gate
}

const owesSettlement = (sessionId: string) =>
  rig.store.getRecord(sessionId)?.lease.settlementRetryRequired === true

describe('settling what a restart left owed', () => {
  it('reads a restart-cut turn before reconcile, and settles it once reconcile lands (L6)', async () => {
    // Hidden: no tab, so only the pass's settlement of open conversations can reach it.
    await rig.chat('session-h', { listed: false, message: 'cut off' })
    await rig.crash()
    const reconcile = Promise.withResolvers<void>()
    const probing = Promise.withResolvers<void>()
    rig.probeOwner.mockImplementation(async () => {
      probing.resolve()
      await reconcile.promise
      return { outcome: 'pid-absent' }
    })
    const host = await rig.boot()
    const acquired = rig.acquire.mock.calls.length

    const pass = host.restoreStartupSessions()
    await probing.promise
    // A read waits on no reconcile.
    const page = await host.history({ sessionId: 'session-h', direction: 'tail' })
    expect(page.ok).toBe(true)
    reconcile.resolve()
    await pass

    expect(owesSettlement('session-h')).toBe(false)
    expect(rig.store.getRecord('session-h')?.lease.settlementRetryId).toBeUndefined()
    expect(rig.acquire.mock.calls.length).toBe(acquired)
  })

  it('settles a listed chat whose child outlived a crash even when its saved status matched (L18)', async () => {
    await rig.chat('session-a', { message: 'one' })
    await rig.chat('session-b', { message: 'two' })
    await rig.quit()
    const second = await rig.boot()
    await second.restoreStartupSessions()
    await rig.chat('session-a')
    rig.savedStatus.flush()
    await rig.crash()
    const dir = journalDirectoryFor(rig.root, {
      workspaceId: 'workspace-1',
      sessionId: 'session-a'
    })
    const saved = rig.savedStatus.read('session-a')
    expect(saved?.v).toBe(STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION)
    expect(saved?.cursor).toEqual(probeJournalCursor(dir, 'session-a'))
    const host = await rig.boot()

    await host.restoreStartupSessions()

    expect(owesSettlement('session-a')).toBe(false)
    expect(rig.opensOf('session-a')).toBe(1)
    expect(rig.opensOf('session-b')).toBe(0)
    // Settling an idle chat changes nothing it shows: the seeded row stands (C9b).
    const rows = rig.statusEvents.flatMap((event) =>
      event.type === 'status' && event.session.sessionId === 'session-a' ? [event.session] : []
    )
    expect(rows.length).toBeGreaterThan(0)
    rows.forEach((row) => expect(row).toEqual(rows[0]))
  })

  it('settles open conversations again after a later reconcile succeeds (L19)', async () => {
    await rig.chat('session-a', { message: 'cut off' })
    await rig.crash()
    let reconcileFails = true
    rig.probeOwner.mockImplementation(async () => {
      if (reconcileFails) {
        throw new Error('probe unavailable')
      }
      return { outcome: 'pid-absent' }
    })
    const host = await rig.boot()
    await host.restoreStartupSessions()
    await host.history({ sessionId: 'session-a', direction: 'tail' })
    expect(rig.store.getRecord('session-a')?.lease.unreconciled).toBe(true)

    reconcileFails = false
    await host.reconcileRestartLeases()

    await vi.waitFor(() => expect(owesSettlement('session-a')).toBe(false))
  })
})

describe('one chat at a time, readers first', () => {
  it('opens by tier, lets a read of another chat through, and settles a chat a read opened (L17)', async () => {
    await rig.chat('session-r', { workspaceId: 'ws-rest', message: 'rest' })
    await rig.chat('session-v', { workspaceId: 'ws-visible', message: 'visible' })
    await rig.chat('session-x', { workspaceId: 'ws-active', message: 'active' })
    await rig.crash()
    const host = await rig.boot()
    const gate = gateOpens()

    const pass = host.restoreStartupSessions({
      activeWorkspaceId: 'ws-active',
      visibleWorkspaceIds: new Set(['ws-visible'])
    })
    await vi.waitFor(() => expect([...gate.held.keys()]).toEqual(['session-x']))
    gate.holding = false
    // The pass is inside session-x's open; a read of a later chat does not wait for it.
    const page = await host.history({ sessionId: 'session-r', direction: 'tail' })
    expect(page.ok).toBe(true)
    expect(owesSettlement('session-r')).toBe(true)
    gate.release('session-x')
    await pass

    expect(rig.historyFilePath.mock.calls.map(([sessionId]) => sessionId)).toEqual([
      'session-x',
      'session-r',
      'session-v'
    ])
    expect(owesSettlement('session-r')).toBe(false)
    expect(owesSettlement('session-v')).toBe(false)
    expect(owesSettlement('session-x')).toBe(false)
  })

  it('opens a chat once when a read queues behind or ahead of the pass (L5, L20)', async () => {
    await rig.chat('session-x', { message: 'first' })
    await rig.chat('session-y', { message: 'second' })
    await rig.quit()
    const host = await rig.boot({ savedStatus: undefined })
    const gate = gateOpens()

    const pass = host.restoreStartupSessions()
    await vi.waitFor(() => expect([...gate.held.keys()]).toEqual(['session-x']))
    const reads = [
      host.history({ sessionId: 'session-y', direction: 'tail' }),
      host.history({ sessionId: 'session-y', direction: 'tail' })
    ]
    await vi.waitFor(() => expect(gate.held.has('session-y')).toBe(true))
    gate.release('session-x')
    gate.holding = false
    gate.release('session-y')
    await Promise.all([pass, ...reads])

    expect(rig.opensOf('session-y')).toBe(1)
    expect(isOpen(rig, 'session-y')).toBe(true)
  })

  it('closes what it opened only for status, never what a reader reached (L21)', async () => {
    await rig.chat('session-p', { message: 'pass only' })
    await rig.chat('session-r', { message: 'reached' })
    await rig.chat('session-u', { message: 'user first' })
    await rig.quit()
    const host = await rig.boot({ savedStatus: undefined })
    await host.history({ sessionId: 'session-u', direction: 'tail' })
    const gate = gateOpens()

    const pass = host.restoreStartupSessions()
    await vi.waitFor(() => expect(gate.held.has('session-p')).toBe(true))
    gate.release('session-p')
    await vi.waitFor(() => expect(gate.held.has('session-r')).toBe(true))
    const read = host.history({ sessionId: 'session-r', direction: 'tail' })
    gate.holding = false
    gate.release('session-r')
    await Promise.all([pass, read])

    expect(isOpen(rig, 'session-p')).toBe(false)
    expect(isOpen(rig, 'session-r')).toBe(true)
    expect(isOpen(rig, 'session-u')).toBe(true)
    expect(rig.sink.publish).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-p', latestPrompt: 'pass only' }),
      expect.anything()
    )
    expect(rig.sink.forget).not.toHaveBeenCalled()
  })
})

describe('recovery at boot', () => {
  it('stops a surviving owner of every resolvable record, hidden or listed, and no other (L8)', async () => {
    await rig.chat('session-r', { message: 'released' })
    await rig.quit()
    await rig.boot()
    const pids: Record<string, number> = { 'session-h': 5001, 'session-l': 5002, 'session-c': 5003 }
    const acquire = rig.acquire.getMockImplementation()!
    rig.acquire.mockImplementation(async (input) => {
      const acquired = await acquire(input)
      const pid = pids[input.identity.sessionId] ?? acquired.process.pid
      return { ...acquired, process: { ...acquired.process, pid } }
    })
    await rig.chat('session-h', { listed: false })
    await rig.chat('session-l')
    await rig.chat('session-c')
    await rig.store.transitionHandoff('session-c', (record) => ({
      ...record,
      lease: { ...record.lease, claimStatus: 'conflicted', handoffStage: 'manual-recovery' }
    }))
    await rig.crash()
    const alive = new Set(Object.values(pids))
    rig.probeOwner.mockImplementation(async (record) =>
      alive.has(record.lease.ownerProcess?.pid ?? -1)
        ? { outcome: 'identity-matched', matchedOn: ['process-start-time'] }
        : { outcome: 'pid-absent' }
    )
    const stopOwnerProcess = vi.fn((pid: number) => {
      alive.delete(pid)
    })
    const host = await rig.boot({ stopOwnerProcess })

    await host.restoreStartupSessions()

    const stopped = new Set(stopOwnerProcess.mock.calls.map(([pid]) => pid))
    expect(stopped).toEqual(new Set([5001, 5002]))
    expect(rig.store.getRecord('session-h')?.lease).toMatchObject({ claimStatus: 'released' })
    expect(rig.store.getRecord('session-r')?.lease).toMatchObject({ claimStatus: 'released' })
    expect(rig.store.getRecord('session-c')?.lease.claimStatus).toBe('conflicted')
  })
})
