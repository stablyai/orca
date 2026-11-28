import { rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { formatAge, queueFileFor, settleChangedCheckSlotCleanup } from './check-changed-slot.mjs'
import {
  createSlotHarness,
  observe,
  shownHolder,
  UNNAMED,
  until,
  registerSlotHarness,
  WAITING,
  within
} from './check-changed-slot.test-harness.mjs'

it.skipIf(process.platform === 'win32')(
  'rejects resource creation by a retained continuation after the next test starts',
  async () => {
    const first = await createSlotHarness({ drainMs: 0 })
    const admitted = Promise.withResolvers()
    const resume = Promise.withResolvers()
    let release
    const late = first.run({}, async (unlock) => {
      release = unlock
      admitted.resolve(first.openQueue())
      await resume.promise
      const probe = first.outsider()
      return probe.tryLock()
    })
    let successor
    try {
      const firstQueue = await within(admitted.promise, 'first continuation admitted')
      await expect(first.teardown()).rejects.toMatchObject({
        errors: [
          expect.objectContaining({
            message: 'a cleanup did not finish before the teardown deadline'
          }),
          expect.objectContaining({ message: expect.stringContaining(first.root) })
        ]
      })
      expect(firstQueue.isOpen).toBe(false)

      successor = await createSlotHarness()
      expect(successor.file).not.toBe(first.file)
      const nextLock = successor.outsider()
      expect(nextLock.tryLock()).toBe(true)
      const nextQueue = successor.openQueue()
      const probe = new DatabaseSync(first.file)
      try {
        expect(() => probe.exec('BEGIN IMMEDIATE')).toThrow('database is locked')
        resume.resolve()
        await expect(late).rejects.toThrow('a test resource was requested after teardown')
        await until(
          () => {
            try {
              probe.exec('BEGIN IMMEDIATE')
              return true
            } catch (error) {
              if (error.errcode !== 5) {
                throw error
              }
              return false
            }
          },
          'retained slot released',
          5000
        )
      } finally {
        probe.close()
      }
      expect(nextQueue.isOpen).toBe(true)
      await successor.teardown()
      successor = undefined
      expect(nextQueue.isOpen).toBe(false)
    } finally {
      resume.resolve()
      await late.catch(() => {})
      await release?.()
      await successor?.teardown()
      await settleChangedCheckSlotCleanup()
      await rm(first.root, { recursive: true, force: true })
    }
  },
  180_000
)

// Production Windows runs check:changed concurrently and never loads the slot; these tests need POSIX ps or /proc.
describe.skipIf(process.platform === 'win32')('check:changed slot queue recovery', () => {
  registerSlotHarness()

  it('names the holder even when the first poll is busy, and admits the waiter after a crash', async ({
    slot
  }) => {
    const { spawnPinnedHolder, file, runWithFreshHolder, root, queueRows } = slot
    const holder = spawnPinnedHolder('await next()', { initialAgeMs: 60_000 })
    await holder.waitFor('held')
    const messages = []
    const exec = DatabaseSync.prototype.exec
    const busy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (sql) {
      if (this.location() === queueFileFor(file) && sql === 'BEGIN IMMEDIATE') {
        throw Object.assign(new Error('first decision is busy'), { errcode: 5 })
      }
      return exec.call(this, sql)
    })
    let waiter
    try {
      waiter = observe(runWithFreshHolder({ log: (message) => messages.push(message) }))
      expect(messages).toEqual([])
    } finally {
      busy.mockRestore()
    }
    await until(() => messages.length > 0, 'first wait message')
    expect(waiter.settled).toBe(false)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(
      new RegExp(
        `^${WAITING} Position 1 of 1\\. The queue last showed pid ${holder.pid} in ${root.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')} holding the slot, claimed \\d+s ago\\.$`
      )
    )
    holder.send('reported')
    await holder.waitFor('resumed')
    await holder.kill()
    await within(waiter.promise, 'waiter after holder crash')
    expect(queueRows().map((row) => row.pid)).toEqual([process.pid])
  }, 240_000)

  it('formats a listed holder with its age at the time of the message', async ({ slot }) => {
    const { createQueue, outsider, insertTicket, runWithFreshHolder } = slot
    await createQueue()
    const other = outsider()
    expect(other.tryLock()).toBe(true)
    insertTicket({ pid: process.pid, heldAt: Date.now() - 5 * 60_000 })
    const messages = []
    const waiter = observe(runWithFreshHolder({ log: (message) => messages.push(message) }))
    await until(() => messages.length > 0, 'wait message')
    expect(messages).toEqual([
      `${WAITING} Position 1 of 1. The queue last showed pid ${process.pid} in /elsewhere holding the slot, claimed 5m ago.`
    ])
    other.close()
    await within(waiter.promise, 'waiter')
  }, 180_000)

  it('stops naming a released holder whose cleanup was blocked once an older checkout takes the slot', async ({
    slot
  }) => {
    const { run, runWithFreshHolder, queueWriter, outsider } = slot
    const staleMs = 3000
    const release = await run({ staleMs })
    const messages = []
    const waiter = observe(
      runWithFreshHolder({ staleMs, log: (message) => messages.push(message) })
    )
    await until(() => messages.length > 0, 'wait message naming the holder')
    expect(messages[0]).toContain(`${shownHolder(process.pid)} in `)
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
  }, 240_000)

  for (const kind of ['fresh dead', 'stale live']) {
    it(`leaves a ${kind} holder unnamed`, async ({ slot }) => {
      const { createQueue, outsider, insertTicket, exitedPid, runWithFreshHolder, run, queueRows } =
        slot
      await createQueue()
      const other = outsider()
      expect(other.tryLock()).toBe(true)
      const dead = kind === 'fresh dead'
      insertTicket({
        pid: dead ? await exitedPid() : process.pid,
        heldAt: Date.now() - 60_000,
        seenAt: Date.now() - (dead ? 0 : 60_000)
      })
      const messages = []
      const acquire = dead ? runWithFreshHolder : run
      const waiter = observe(acquire({ log: (message) => messages.push(message) }))
      await until(() => messages.length > 0, 'wait message')
      expect(messages).toEqual([`${WAITING} Position 1 of 1. ${UNNAMED}`])
      other.close()
      await within(waiter.promise, 'waiter')
      expect(queueRows().filter((row) => row.held_at !== null)).toHaveLength(1)
    }, 180_000)
  }

  it('bounds release grace by elapsed time when the wall clock steps backward', async ({
    slot
  }) => {
    const { run, queueWriter, outsider } = slot
    const release = await run({ staleMs: 1000 })
    const writer = await queueWriter()
    const now = Date.now()
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(now)
      .mockReturnValue(now - 300_000)
    try {
      await within(release(), 'release despite a backward wall-clock step', 10_000)
      const other = outsider()
      expect(other.tryLock()).toBe(true)
      other.close()
    } finally {
      clock.mockRestore()
      await writer.kill()
    }
  }, 180_000)

  it('never re-creates its held ticket after the row is lost, and still releases', async ({
    slot
  }) => {
    const { run, queueRows, openQueue, outsider } = slot
    const staleMs = 1500
    const release = await run({ staleMs })
    const [held] = queueRows()
    const db = openQueue()
    db.prepare('DELETE FROM tickets_v4 WHERE id = ?').run(held.id)
    // Several holder heartbeats pass with the row gone.
    await delay((staleMs / 15) * 5)
    expect(queueRows()).toEqual([])
    const other = outsider()
    expect(other.tryLock()).toBe(false)
    await within(release(), 'release')
    expect(other.tryLock()).toBe(true)
    expect(queueRows()).toEqual([])
  }, 180_000)

  it('keeps holding the slot when its queue metadata breaks, and still releases it', async ({
    slot
  }) => {
    const { run, openQueue, outsider } = slot
    const staleMs = 1500
    const release = await run({ staleMs })
    const db = openQueue()
    db.exec('DROP TABLE tickets_v4')
    // Holder heartbeats now fail with a non-busy error; none may escape or end the hold.
    await delay((staleMs / 15) * 5)
    const other = outsider()
    expect(other.tryLock()).toBe(false)
    await within(release(), 'release with broken metadata')
    expect(other.tryLock()).toBe(true)
  }, 180_000)

  it('removes its ticket when acquisition fails, so the next call is not held up', async ({
    slot
  }) => {
    const { run, queueRows } = slot
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
    // A leftover fresh ticket would block this call for the whole minute-long stale window; 30 s is half of it.
    await within(run({ staleMs: 60_000 }), 'next call', 30_000)
  }, 180_000)

  it('lets the next call through once a queue writer stalls cleanup of an aborted call', async ({
    slot
  }) => {
    const { run, queueRows, queueWriter } = slot
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
    await within(next.promise, 'next call after the writer left', 30_000)
    await settleChangedCheckSlotCleanup()
    expect(queueRows().filter((row) => row.held_at === null)).toEqual([])
  }, 240_000)

  it('keeps waiters pending while another process holds the queue database, then admits them in order', async ({
    slot
  }) => {
    const { run, queueRows, queueWriter } = slot
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
  }, 240_000)

  it('corrects its place once a ticket beyond the run ahead dies and is removed', async ({
    slot
  }) => {
    const { run, insertTicket, openQueue, queueRows, spawnOwned } = slot
    // Long enough that no ticket here goes silent during the test, even on a loaded host.
    const staleMs = 15_000
    const holder = await run({ staleMs })
    // Leave a gap in the ids so another ticket can be placed ahead of a waiter that already polled.
    const gap = insertTicket({ pid: process.pid })
    openQueue().prepare('DELETE FROM tickets_v4 WHERE id = ?').run(gap)
    const middle = run({ staleMs, pollMs: 50 })
    await until(() => queueRows().length === 2, 'middle ticket')
    // A live process owns the ticket ahead of the middle waiter, so both waiters count it.
    const owner = spawnOwned(`await next()`)
    insertTicket({ id: gap, pid: owner.pid })
    const messages = []
    const waiter = observe(run({ staleMs, log: (message) => messages.push(message) }))
    await until(() => messages.length > 0, 'first wait message')
    expect(messages[0]).toMatch(new RegExp(`^${WAITING} Position 3 of 3\\.(?: |$)`))
    // Our waiter only reads the middle waiter. When the owner dies, the middle waiter removes its
    // ticket; our count must follow without any change in the run ahead of us or the holder.
    await owner.kill()
    await until(() => !queueRows().some((row) => row.id === gap), 'dead ticket removed')
    await until(
      () => messages.at(-1).match(new RegExp(`^${WAITING} Position 2 of 2\\.(?: |$)`)),
      'corrected position',
      staleMs
    )
    await holder()
    await (
      await within(middle, 'middle waiter')
    )()
    await within(waiter.promise, 'waiter')
  }, 240_000)

  it('formats holder ages', () => {
    expect(formatAge(12_000)).toBe('12s')
    expect(formatAge(5 * 60_000)).toBe('5m')
    expect(formatAge(125 * 60_000)).toBe('2h 5m')
  })
})
