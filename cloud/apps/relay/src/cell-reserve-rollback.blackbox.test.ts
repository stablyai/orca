import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { RESERVE_DEAD_MAN_MS } from './cell-reserve-dead-man.js'
import { openRelayDatabase } from './database.js'
import { REREGISTER_MAX_ATTEMPTS } from './host-session-registry.js'
import { startReserveModeCell } from './test-fixtures/reserve-mode-cell.js'

// Flip back (E-mix): a cell leaves reserve mode with hosts it admitted from memory. Nobody is
// disconnected, and the database ends up holding exactly the leases its seat report names.

const byHost = (left: Record<string, unknown>, right: Record<string, unknown>) =>
  String(left.relay_host_id) < String(right.relay_host_id) ? -1 : 1

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not reached')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('flipping a reserve-mode cell back to the database', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
    vi.restoreAllMocks()
  })

  async function cell(now?: () => number) {
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const dataDir = mkdtempSync(join(tmpdir(), 'orca-relay-reserve-rollback-'))
    cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
    const database = await openRelayDatabase({ dataDir })
    cleanup.push(() => database.close())
    return await startReserveModeCell({ database, dataDir, cleanup, ...(now ? { now } : {}) })
  }

  it('registers every memory-admitted control without disconnecting any, matching the seat report', async () => {
    const reserve = await cell()
    const first = await reserve.bookedHost(5)
    const second = await reserve.bookedHost(6)
    // The ledger lags by up to a second: this row lands only after the flip.
    const late = await reserve.bookedHost(7, { row: 'never' })
    expect(await reserve.controlLeases()).toEqual([])
    const marked = vi.spyOn(reserve.relay.assignments, 'markMigrationTargetRegistered')

    reserve.setAdmitMode('db')
    await until(async () => (await reserve.controlLeases()).length === 2)
    // Still reporting reserve: sweeps must not resume while a control lacks its lease.
    expect(reserve.relay.sessions.reregistrationPending()).toBeGreaterThan(0)
    await reserve.insertRow(late.identity.hostId, 7)
    await until(async () => (await reserve.controlLeases()).length === 3)
    await until(() => reserve.relay.sessions.reregistrationPending() === 0)

    expect([first, second, late].every((entry) => entry.socket.readyState === WebSocket.OPEN)).toBe(true)
    const page = reserve.relay.sessions.seatFeed(null)
    const seats = 'full' in page ? page.full : []
    expect(
      seats
        .map((seat) => ({
          relay_host_id: seat.relayHostId,
          cell_id: 'production-gce-c3',
          activity_id: `control:production-gce-c3:${seat.generation}`
        }))
        .sort(byHost)
    ).toEqual((await reserve.controlLeases()).sort(byHost))
    // As a database-path join does, each one also tells an open migration its host arrived.
    expect(marked.mock.calls.map(([, input]) => input.assignmentEpoch).sort()).toEqual([5, 6, 7])
    // A second flip back has nothing left to register.
    expect(reserve.relay.sessions.reregisterMemoryControls()).toBe(0)
  }, 30_000)

  it('closes with 4409 a control whose row never names this cell, after every retry', async () => {
    let now = Date.now()
    const reserve = await cell(() => now)
    // The database says another cell owns it: the lease can never be taken here.
    const stranded = await reserve.bookedHost(5, { row: 'production-gce-c9' })
    const fine = await reserve.bookedHost(6)
    const tries = vi.spyOn(reserve.relay.assignments, 'activateControlDeferringCell')
    reserve.setAdmitMode('db')
    for (let step = 0; step < 3 * REREGISTER_MAX_ATTEMPTS && stranded.socket.readyState === WebSocket.OPEN; step += 1) {
      now += 6_000
      // Both desktops stay alive on the test clock: a pong resets the control silence timer.
      for (const entry of [stranded, fine]) {
        if (entry.socket.readyState === WebSocket.OPEN) entry.socket.send(JSON.stringify({ type: 'pong', t: now }))
      }
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
    expect(await stranded.closeCode).toBe(4409)
    // Every retry was spent first: the row may still have been on its way.
    expect(tries.mock.calls.length).toBeGreaterThanOrEqual(REREGISTER_MAX_ATTEMPTS + 1)
    await until(() => reserve.relay.sessions.reregistrationPending() === 0)
    expect(fine.socket.readyState).toBe(WebSocket.OPEN)
    expect((await reserve.controlLeases()).map((row) => row.relay_host_id)).toEqual([fine.identity.hostId])
  }, 30_000)

  it('leases a control whose proof lands after the flip, though memory admitted its hello', async () => {
    const reserve = await cell()
    const identity = await reserve.host()
    await reserve.insertRow(identity.hostId, 4)
    reserve.relay.sessions.reserve({
      v: 1,
      directorId: 'director-a',
      items: [{ userId: 'user-1', relayHostId: identity.hostId, epoch: 4, ttlMs: 30_000 }]
    })
    // The flip lands between the hello (admitted from the booking) and the proof.
    const activate = vi.spyOn(reserve.relay.assignments, 'activateControl')
    const pending = reserve.connect(identity, 4)
    reserve.setAdmitMode('db')
    const reply = await pending
    expect(reply.ack).toMatchObject({ type: 'host-hello-ack' })
    await until(async () => (await reserve.controlLeases()).length === 1)
    // The proof took the lease itself, or the rescan did: either way exactly one.
    expect(activate.mock.calls.length + reserve.relay.sessions.reregistrationPending()).toBeLessThanOrEqual(1)
    expect(reply.socket.readyState).toBe(WebSocket.OPEN)
  }, 30_000)

  it('flips itself back to db when no placing director has been in touch for the dead-man window', async () => {
    let now = Date.now()
    const reserve = await cell(() => now)
    const seated = await reserve.bookedHost(3)
    expect(reserve.relay.sessions.inReserveMode()).toBe(true)
    // A booking is contact: the window restarts.
    now += RESERVE_DEAD_MAN_MS - 1_000
    await reserve.bookedHost(4)
    now += RESERVE_DEAD_MAN_MS - 1_000
    expect(reserve.relay.sessions.inReserveMode()).toBe(true)
    now += 2_000
    expect(reserve.relay.sessions.inReserveMode()).toBe(false)
    await until(async () => (await reserve.controlLeases()).length === 2)
    expect(seated.socket.readyState).toBe(WebSocket.OPEN)
    // Latched for this switch generation: contact again does not bring reserve back.
    reserve.relay.sessions.reserve({
      v: 1,
      directorId: 'director-a',
      items: [{ userId: 'user-1', relayHostId: 'abcdefghijklmnop', epoch: 9, ttlMs: 30_000 }]
    })
    expect(reserve.relay.sessions.inReserveMode()).toBe(false)
    // A new write of the switch does.
    reserve.setAdmitMode('reserve')
    expect(reserve.relay.sessions.inReserveMode()).toBe(true)
  }, 30_000)
})
