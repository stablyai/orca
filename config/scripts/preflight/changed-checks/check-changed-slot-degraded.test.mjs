import { readdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { queueFileFor } from './check-changed-slot.mjs'
import {
  exitedPid,
  file,
  insertTicket,
  observe,
  openQueue,
  outsider,
  queueRows,
  registerSlotHarness,
  run,
  spawnOwned,
  until,
  within
} from './check-changed-slot.test-harness.mjs'

registerSlotHarness()

const DEGRADED =
  /^The check:changed queue could not be used \(.+\); waiting for the slot without it\.$/

/** Makes every delete matching `where` fail as a write error would, until the trigger is dropped. */
function failDeletes(db, where, name) {
  db.exec(`CREATE TRIGGER ${name} BEFORE DELETE ON tickets_v4 WHEN ${where}
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`)
  return () => db.exec(`DROP TRIGGER IF EXISTS ${name}`)
}

// Production Windows runs check:changed concurrently and never loads the slot; these tests need POSIX ps or /proc.
describe.skipIf(process.platform === 'win32')('check:changed slot without a usable queue', () => {
  it('waits for the slot directly when the queue cannot open, still one holder at a time', async () => {
    await mkdir(queueFileFor(file), { recursive: true })
    // Counted before any connection opens; compared once every connection here has closed.
    const before = readdirSync('/dev/fd').length
    const other = outsider()
    expect(other.tryLock()).toBe(true)
    const messages = []
    const waiter = observe(run({ log: (message) => messages.push(message) }))
    await until(() => messages.length > 0, 'warning')
    await delay(200)
    // One warning, and no admission while another connection holds the slot lock.
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(DEGRADED)
    expect(waiter.settled).toBe(false)
    other.close()
    const release = await within(waiter.promise, 'waiter after the slot freed')
    const check = outsider()
    expect(check.tryLock()).toBe(false)
    await release()
    expect(check.tryLock()).toBe(true)
    check.close()
    expect(readdirSync('/dev/fd').length).toBe(before)
  }, 180_000)

  it('waits for the slot directly when its join fails, and a later call uses the queue again', async () => {
    await (
      await run()
    )()
    const db = openQueue()
    db.exec(`CREATE TRIGGER fail_join BEFORE INSERT ON tickets_v4
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`)
    const messages = []
    const release = await within(
      run({ log: (message) => messages.push(message) }),
      'waiter without the queue'
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatch(DEGRADED)
    expect(messages[0]).toContain('simulated write failure')
    await release()
    db.exec('DROP TRIGGER fail_join')
    const later = []
    const releaseLater = await within(run({ log: (message) => later.push(message) }), 'later call')
    expect(later).toEqual([])
    expect(queueRows().filter((row) => row.held_at !== null)).toHaveLength(1)
    await releaseLater()
  }, 180_000)

  for (const { label, poison } of [
    {
      label: 'an expired ticket cannot be deleted',
      poison: async (db) => {
        const id = insertTicket({ pid: process.pid, seenAt: Date.now() - 60 * 60_000, lane: 2 })
        return failDeletes(db, `old.id = ${id}`, 'keep_expired')
      }
    },
    {
      label: '17 dead tickets ahead cannot be deleted',
      poison: async (db) => {
        const dead = await exitedPid()
        for (let index = 0; index < 17; index++) {
          insertTicket({ pid: dead })
        }
        return failDeletes(db, `old.pid = ${dead}`, 'keep_dead')
      }
    },
    {
      label: 'a left-over held ticket cannot be deleted',
      poison: async (db) => {
        const id = insertTicket({
          pid: process.pid,
          heldAt: Date.now() - 60_000,
          seenAt: Date.now() - 60_000
        })
        return failDeletes(db, `old.id = ${id}`, 'keep_held')
      }
    }
  ]) {
    it(`waits for the slot directly when ${label}, one holder at a time, and uses the queue again once it can`, async () => {
      const holder = await run()
      const db = openQueue()
      const recover = await poison(db)
      const messages = []
      const waiter = observe(run({ log: (message) => messages.push(message) }))
      // Exclusion holds in either mode: nothing is admitted while the holder holds the slot.
      await delay(300)
      expect(waiter.settled).toBe(false)
      await holder()
      const release = await within(waiter.promise, 'waiter after the holder left')
      expect(messages.filter((message) => DEGRADED.test(message))).toHaveLength(1)
      await release()
      // Once the rows can be deleted, the queue works again and clears them.
      recover()
      const later = []
      const releaseLater = await within(
        run({ log: (message) => later.push(message) }),
        'later call'
      )
      expect(later.filter((message) => DEGRADED.test(message))).toEqual([])
      await releaseLater()
      await (
        await within(run({ staleMs: 1000 }), 'cleanup pass')
      )()
      expect(queueRows()).toEqual([])
    }, 180_000)
  }

  it('keeps exactly one holder at a time across processes while every waiter is without the queue', async () => {
    await (
      await run()
    )()
    const db = openQueue()
    // Every decision expires this row first, so every queue-aware waiter falls back.
    const id = insertTicket({ pid: process.pid, seenAt: Date.now() - 60 * 60_000, lane: 2 })
    failDeletes(db, `old.id = ${id}`, 'keep_expired')
    const intervals = []
    const messages = []
    const hold = async (release) => {
      const start = Date.now()
      await delay(40)
      intervals.push({ start, end: Date.now() })
      await release()
    }
    const inProcess = Array.from({ length: 4 }, () =>
      run({ log: (message) => messages.push(message) }, hold)
    )
    const children = Array.from({ length: 2 }, () =>
      spawnOwned(`let warned = false
const release = await acquireChangedCheckSlot(file, {
  pollMs: 5,
  ancestors: [],
  log: (message) => {
    warned ||= message.startsWith('The check:changed queue could not be used')
  }
})
const start = Date.now()
await new Promise((resolve) => setTimeout(resolve, 40))
const end = Date.now()
await release()
process.stdout.write(JSON.stringify({ start, end, warned }) + '\\n')
process.exit(0)`)
    )
    await within(Promise.all(inProcess), 'in-process waiters')
    const results = await within(Promise.all(children.map(({ closed }) => closed)), 'child waiters')
    expect(results.map(({ code }) => code)).toEqual([0, 0])
    const childRuns = children.map(({ output }) => JSON.parse(output()))
    expect(childRuns.map(({ warned }) => warned)).toEqual([true, true])
    expect(messages.filter((message) => DEGRADED.test(message))).toHaveLength(4)
    const all = [...intervals, ...childRuns].toSorted((a, b) => a.start - b.start)
    expect(all).toHaveLength(6)
    for (let index = 1; index < all.length; index++) {
      expect(all[index].start).toBeGreaterThanOrEqual(all[index - 1].end)
    }
  }, 180_000)
})
