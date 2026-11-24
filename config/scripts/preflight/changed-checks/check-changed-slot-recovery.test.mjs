import { readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import {
  acquireChangedCheckSlot,
  formatAge,
  queueFileFor,
  settleChangedCheckSlotCleanup
} from './check-changed-slot.mjs'
import {
  createQueue,
  exitedPid,
  file,
  insertTicket,
  observe,
  openQueue,
  outsider,
  queueRows,
  queueWriter,
  root,
  run,
  spawnOwned,
  UNNAMED,
  until,
  registerSlotHarness,
  WAITING,
  within
} from './check-changed-slot.test-harness.mjs'

registerSlotHarness()

// Production Windows runs check:changed concurrently and never loads the slot; these tests need POSIX ps or /proc.
describe.skipIf(process.platform === 'win32')('check:changed slot queue recovery', () => {
  it('admits the next waiter when the holder process is killed, and names the holder while waiting', async () => {
    const holder =
      spawnOwned(`await acquireChangedCheckSlot(file, { pollMs: 5, ancestors: [], log: () => {} })
process.stdout.write('held\\n')
await next()`)
    await holder.waitFor('held')
    const messages = []
    const waiter = observe(run({ log: (message) => messages.push(message) }))
    await until(() => messages.length > 0, 'first wait message')
    await delay(100)
    expect(waiter.settled).toBe(false)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(
      new RegExp(
        `^${WAITING} Position 1 of 1\\. Running now: pid ${holder.pid} in ${root.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}, started \\d+s ago\\.$`
      )
    )
    await holder.kill()
    await within(waiter.promise, 'waiter after holder crash')
    expect(queueRows().map((row) => row.pid)).toEqual([process.pid])
  }, 60_000)

  it('formats a listed holder with its age at the time of the message', async () => {
    await createQueue()
    const other = outsider()
    expect(other.tryLock()).toBe(true)
    insertTicket({ pid: process.pid, heldAt: Date.now() - 5 * 60_000 })
    const messages = []
    const waiter = observe(run({ log: (message) => messages.push(message) }))
    await until(() => messages.length > 0, 'wait message')
    expect(messages).toEqual([
      `${WAITING} Position 1 of 1. Running now: pid ${process.pid} in /elsewhere, started 5m ago.`
    ])
    other.close()
    await within(waiter.promise, 'waiter')
  }, 30_000)

  it('stops naming a released holder whose cleanup was blocked once an older checkout takes the slot', async () => {
    const staleMs = 3000
    const release = await run({ staleMs })
    const messages = []
    const waiter = observe(run({ staleMs, log: (message) => messages.push(message) }))
    await until(() => messages.length > 0, 'wait message naming the holder')
    expect(messages[0]).toContain(`Running now: pid ${process.pid} in `)
    const writer = await queueWriter()
    const releasedAt = Date.now()
    const released = release()
    const legacy = outsider()
    // While its ticket cannot be removed, the holder keeps the slot until its heartbeat is too old to name.
    await until(() => legacy.tryLock(), 'older checkout taking the slot')
    expect(Date.now() - releasedAt).toBeGreaterThanOrEqual(staleMs / 5 - 50)
    await within(released, 'holder release')
    const beforeTakeover = messages.length
    await writer.kill()
    await until(() => messages.length > beforeTakeover, 'message after takeover')
    await delay(200)
    for (const message of messages.slice(beforeTakeover)) {
      expect(message).toBe(`${WAITING} Position 1 of 1. ${UNNAMED}`)
    }
    expect(waiter.settled).toBe(false)
    legacy.close()
    await within(waiter.promise, 'waiter')
  }, 60_000)

  it('leaves the holder unnamed when no live, heartbeating ticket holds the slot', async () => {
    await createQueue()
    const other = outsider()
    expect(other.tryLock()).toBe(true)
    insertTicket({ pid: await exitedPid(), heldAt: Date.now() })
    insertTicket({ pid: process.pid, heldAt: Date.now() - 60_000, seenAt: Date.now() - 60_000 })
    const messages = []
    const waiter = observe(run({ staleMs: 30_000, log: (message) => messages.push(message) }))
    await until(() => messages.length > 0, 'wait message')
    expect(messages).toEqual([`${WAITING} Position 1 of 1. ${UNNAMED}`])
    other.close()
    await within(waiter.promise, 'waiter')
    expect(queueRows().filter((row) => row.held_at !== null)).toHaveLength(1)
  }, 30_000)

  it('never re-creates its held ticket after the row is lost, and still releases', async () => {
    const staleMs = 1500
    const release = await run({ staleMs })
    const [held] = queueRows()
    const db = openQueue()
    db.prepare('DELETE FROM tickets_v2 WHERE id = ?').run(held.id)
    // Several holder heartbeats pass with the row gone.
    await delay((staleMs / 15) * 5)
    expect(queueRows()).toEqual([])
    const other = outsider()
    expect(other.tryLock()).toBe(false)
    await within(release(), 'release')
    expect(other.tryLock()).toBe(true)
    expect(queueRows()).toEqual([])
  }, 30_000)

  it('keeps holding the slot when its queue metadata breaks, and still releases it', async () => {
    const staleMs = 1500
    const release = await run({ staleMs })
    const db = openQueue()
    db.exec('DROP TABLE tickets_v2')
    // Holder heartbeats now fail with a non-busy error; none may escape or end the hold.
    await delay((staleMs / 15) * 5)
    const other = outsider()
    expect(other.tryLock()).toBe(false)
    await within(release(), 'release with broken metadata')
    expect(other.tryLock()).toBe(true)
  }, 30_000)

  it('removes its ticket when acquisition fails, so the next call is not held up', async () => {
    const holder = await run()
    const failing = run({
      staleMs: 60_000,
      log: () => {
        throw new Error('log failed')
      }
    })
    await expect(failing).rejects.toThrow('log failed')
    await settleChangedCheckSlotCleanup()
    expect(queueRows().filter((row) => row.held_at === null)).toEqual([])
    await holder()
    // A leftover fresh ticket would block this call for the whole minute-long stale window.
    await within(run({ staleMs: 60_000 }), 'next call', 10_000)
  }, 30_000)

  it('lets the next call through once a queue writer stalls cleanup of an aborted call', async () => {
    const holder = await run({ staleMs: 3000 })
    const aborted = run({ staleMs: 60_000 })
    await until(() => queueRows().some((row) => row.held_at === null), 'queued ticket')
    const writer = await queueWriter()
    aborted.abort()
    await expect(aborted).rejects.toThrow()
    const released = holder()
    const next = observe(run({ staleMs: 60_000 }))
    // Longer than a finite retry budget would last, while the aborted ticket stays fresh.
    await delay(1500)
    expect(next.settled).toBe(false)
    await within(released, 'holder release')
    await writer.kill()
    // Well inside the aborted ticket's minute-long stale window.
    await within(next.promise, 'next call after the writer left', 10_000)
    await settleChangedCheckSlotCleanup()
    expect(queueRows().filter((row) => row.held_at === null)).toEqual([])
  }, 60_000)

  it('keeps waiters pending while another process holds the queue database, then admits them in order', async () => {
    const holder = await run({ staleMs: 3000 })
    const order = []
    const queued = observe(
      run({}, (release) => {
        order.push('queued')
        return release
      })
    )
    await until(() => queueRows().some((row) => row.held_at === null), 'queued ticket')
    const writer = await queueWriter()
    const arrival = observe(
      run({}, (release) => {
        order.push('arrival')
        return release()
      })
    )
    const released = holder()
    await delay(1500)
    expect(queued.settled).toBe(false)
    expect(arrival.settled).toBe(false)
    await within(released, 'holder release')
    await writer.kill()
    const releaseQueued = await within(queued.promise, 'queued waiter')
    await delay(100)
    expect(arrival.settled).toBe(false)
    await releaseQueued()
    await within(arrival.promise, 'arrival')
    expect(order).toEqual(['queued', 'arrival'])
    expect(queued.error).toBeUndefined()
    expect(arrival.error).toBeUndefined()
  }, 60_000)

  it('corrects its place once a dead ticket beyond the run ahead is removed', async () => {
    // The middle waiter polls inside the stale window but slower than our recount, so the dead
    // ticket stays visible to our count for at least one recount before the middle removes it.
    const staleMs = 6000
    const holder = await run({ staleMs })
    // Leave a gap in the ids so a dead ticket can be placed ahead of a waiter that already polled.
    const gap = insertTicket({ pid: process.pid })
    openQueue().prepare('DELETE FROM tickets_v2 WHERE id = ?').run(gap)
    const middle = run({ staleMs, pollMs: 4000 })
    await until(() => queueRows().length === 2, 'middle ticket')
    const messages = []
    const waiter = observe(run({ staleMs, log: (message) => messages.push(message) }))
    await until(() => messages.length > 0, 'first wait message')
    // Our waiter only reads the middle waiter; the dead ticket lies beyond it.
    insertTicket({ id: gap, pid: await exitedPid() })
    await until(
      () => messages.some((message) => message.startsWith(`${WAITING} Position 3 of 3.`)),
      'count including the dead ticket',
      10_000
    )
    // The middle waiter removes the dead ticket on its next poll; the recount follows.
    await until(
      () => messages.at(-1).startsWith(`${WAITING} Position 2 of 2.`),
      'corrected position',
      10_000
    )
    await holder()
    await (
      await within(middle, 'middle waiter')
    )()
    await within(waiter.promise, 'waiter')
  }, 30_000)

  it('closes the slot connection and keeps the original error when the queue cannot open', async () => {
    await mkdir(queueFileFor(file), { recursive: true })
    const before = readdirSync('/dev/fd').length
    await expect(acquireChangedCheckSlot(file, { ancestors: [], log: () => {} })).rejects.toThrow(
      /unable to open/i
    )
    expect(readdirSync('/dev/fd').length).toBe(before)
  }, 30_000)

  it('formats holder ages', () => {
    expect(formatAge(12_000)).toBe('12s')
    expect(formatAge(5 * 60_000)).toBe('5m')
    expect(formatAge(125 * 60_000)).toBe('2h 5m')
  })
})
