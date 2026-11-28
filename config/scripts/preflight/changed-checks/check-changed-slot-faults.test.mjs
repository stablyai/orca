import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { settleChangedCheckSlotCleanup } from './check-changed-slot.mjs'
import {
  observe,
  registerSlotHarness,
  shownHolder,
  UNNAMED,
  until,
  WAITING,
  within
} from './check-changed-slot.test-harness.mjs'

registerSlotHarness()

/** Makes every delete of one ticket fail as a write error would, until the trigger is dropped. */
function failDeletes(db, id, name) {
  db.exec(`CREATE TRIGGER ${name} BEFORE DELETE ON tickets_v4 WHEN old.id = ${id}
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`)
  return () => db.exec(`DROP TRIGGER IF EXISTS ${name}`)
}

// Production Windows runs check:changed concurrently and never loads the slot; these tests need POSIX ps or /proc.
describe.skipIf(process.platform === 'win32')('check:changed slot queue faults', () => {
  it('does not name a holder that left while this waiter was paused mid-decision', async ({
    slot
  }) => {
    const { root, spawnOwned, spawnPinnedHolder, runWithFreshHolder } = slot
    // Holders heartbeat every 200 ms and are named for 600 ms.
    const staleMs = 3000
    const signalFile = join(root, 'paused')
    const tookFile = join(root, 'took')
    const holder = spawnPinnedHolder(
      `// Releases once the paused decision below signals that it holds the queue.
const { existsSync } = await import('node:fs')
while (!existsSync(${JSON.stringify(signalFile)})) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
await release()
process.stdout.write('released\\n')
await next()`,
      { staleMs }
    )
    await holder.waitFor('held')
    // A run from an older checkout: it takes the slot directly as soon as it can.
    const legacy = spawnOwned(`const db = new DatabaseSync(file)
process.stdout.write('ready\\n')
await next()
process.stdout.write('armed\\n')
for (;;) {
  try {
    db.exec('BEGIN IMMEDIATE')
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const { writeFileSync } = await import('node:fs')
writeFileSync(${JSON.stringify(tookFile)}, '')
process.stdout.write('took\\n')
await next()`)
    await legacy.waitFor('ready')
    legacy.send('take')
    await legacy.waitFor('armed')
    const messages = []
    let pause = false
    let pausedUntilTakeover
    // True only during the synchronous turn of the decision that was paused.
    let resumed = false
    const waiter = observe(
      runWithFreshHolder({
        staleMs,
        log: (message) => {
          messages.push({ message, resumed })
          if (messages.length === 1) {
            holder.send('reported')
            pause = true
          }
        },
        // Holds this waiter inside its decision transaction, and so the queue's write lock, until
        // the older checkout has taken the slot (at most 60 s).
        beforeClaim: () => {
          if (!pause) {
            return
          }
          pause = false
          writeFileSync(signalFile, '')
          const deadline = Date.now() + 60_000
          while (!existsSync(tookFile) && Date.now() < deadline) {
            // Busy wait: the whole event loop pauses, as on a descheduled host.
          }
          pausedUntilTakeover = existsSync(tookFile)
          resumed = true
          queueMicrotask(() => {
            resumed = false
          })
        }
      })
    )
    await until(() => messages.length > 0, 'message naming the holder')
    expect(messages[0].message).toContain(`${shownHolder(holder.pid)} in `)
    // The holder releases once the pause begins and cannot remove its ticket while the paused
    // decision holds the queue; it unlocks once it can no longer be named, and the older
    // checkout takes the slot. The paused decision then resumes and reports.
    await until(() => pausedUntilTakeover !== undefined, 'paused decision resuming')
    // The older checkout took the slot while this decision was still paused.
    expect(pausedUntilTakeover).toBe(true)
    await until(() => messages.length > 1, 'report after the pause')
    // The paused decision itself must correct the line at once: repeating the old holder would
    // print nothing new and leave its name showing after the older checkout took over.
    expect(messages[1]).toEqual({
      message: `${WAITING} Position 1 of 1. ${UNNAMED}`,
      resumed: true
    })
    expect(waiter.settled).toBe(false)
  }, 180_000)

  it('keeps the slot after a release whose ticket removal fails, until the holder can no longer be named', async ({
    slot
  }) => {
    const {
      run,
      queueRows,
      openQueue,
      insertTicket,
      keepCheckingIn,
      runWithFreshHolder,
      outsider
    } = slot
    const staleMs = 3000
    const release = await run({ staleMs })
    const [held] = queueRows()
    const db = openQueue()
    const recover = failDeletes(db, held.id, 'keep_held')
    // A live ticket ahead keeps this waiter from ever claiming, so only the older checkout below
    // can take the slot when it frees.
    const ahead = insertTicket({ pid: process.pid })
    keepCheckingIn(ahead)
    const messages = []
    const waiter = observe(
      runWithFreshHolder({ staleMs, log: (message) => messages.push({ message, at: Date.now() }) })
    )
    await until(() => messages.length > 0, 'message naming the holder')
    expect(messages[0].message).toContain(`${shownHolder(process.pid)} in `)
    const legacy = outsider()
    const releasedAt = Date.now()
    const released = release()
    await until(() => legacy.tryLock(), 'older checkout taking the slot')
    const takenAt = Date.now()
    // The slot stayed locked until the holder's last heartbeat was too old to name it.
    expect(takenAt - releasedAt).toBeGreaterThanOrEqual(staleMs / 5 - 50)
    await within(released, 'release')
    // The ticket survived the failed removal and is still readable.
    expect(queueRows().some((row) => row.id === held.id && row.held_at !== null)).toBe(true)
    await delay(500)
    expect(messages.at(-1).message).toBe(`${WAITING} Position 2 of 2.`)
    // Named while it held the slot, never once the older checkout could have taken it.
    for (const { message } of messages.filter(({ at }) => at >= releasedAt + staleMs / 5)) {
      expect(message).not.toContain('The queue last showed')
    }
    recover()
    db.prepare('DELETE FROM tickets_v4 WHERE id = ?').run(ahead)
    legacy.close()
    await within(waiter.promise, 'waiter')
    await settleChangedCheckSlotCleanup()
    expect(queueRows().some((row) => row.id === held.id)).toBe(false)
  }, 180_000)

  it('reports a holder only as what the queue last showed, even when it hands over before the line prints', async ({
    slot
  }) => {
    const { root, spawnOwned, run } = slot
    // The handover handshake orders the events. The name still depends on the last heartbeat
    // being within the 24 s naming window when the line prints.
    const staleMs = 120_000
    const signalFile = join(root, 'decided')
    const tookFile = join(root, 'took')
    const holder = spawnOwned(`const release = await acquireChangedCheckSlot(file, {
  staleMs: ${staleMs},
  pollMs: 5,
  ancestors: [],
  log: () => {}
})
process.stdout.write('held\\n')
const { existsSync } = await import('node:fs')
while (!existsSync(${JSON.stringify(signalFile)})) {
  await new Promise((resolve) => setTimeout(resolve, 5))
}
await release()
process.stdout.write('released\\n')
await next()`)
    await holder.waitFor('held')
    const legacy = spawnOwned(`const db = new DatabaseSync(file)
for (;;) {
  try {
    db.exec('BEGIN IMMEDIATE')
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const { writeFileSync } = await import('node:fs')
writeFileSync(${JSON.stringify(tookFile)}, '')
await next()`)
    const messages = []
    let resumed = false
    let tookBeforeLine
    observe(
      run({
        staleMs,
        log: (message) => messages.push({ message, resumed }),
        // After the first decision commits and before its line prints: the holder releases
        // cleanly (the queue is free), and the older checkout takes the slot.
        beforeReport: () => {
          if (messages.length > 0 || tookBeforeLine !== undefined) {
            return
          }
          writeFileSync(signalFile, '')
          const deadline = Date.now() + 60_000
          while (!existsSync(tookFile) && Date.now() < deadline) {
            // Busy wait: the whole event loop pauses.
          }
          tookBeforeLine = existsSync(tookFile)
          resumed = true
          queueMicrotask(() => {
            resumed = false
          })
        }
      })
    )
    await until(() => messages.length > 0, 'first line')
    expect(tookBeforeLine).toBe(true)
    // The first line describes the past check, which did show this holder, and claims nothing
    // about who holds the slot now.
    expect(messages[0].resumed).toBe(true)
    expect(messages[0].message).toMatch(
      new RegExp(
        `^${WAITING} Position 1 of 1\\. The queue last showed pid ${holder.pid} in .+ holding the slot, claimed \\d+s ago\\.$`
      )
    )
    expect(legacy.errors).toEqual([])
  }, 180_000)

  it('never shows a holder whose heartbeat is in the future, as after the clock steps back', async ({
    slot
  }) => {
    const { run, outsider, insertTicket } = slot
    await (
      await run()
    )()
    const other = outsider()
    expect(other.tryLock()).toBe(true)
    // A live pid whose last heartbeat reads 5 s ahead of this clock.
    insertTicket({ pid: process.pid, heldAt: Date.now() - 60_000, seenAt: Date.now() + 5000 })
    const messages = []
    const waiter = observe(run({ log: (message) => messages.push(message) }))
    await until(() => messages.length > 0, 'wait message')
    expect(messages).toEqual([`${WAITING} Position 1 of 1. ${UNNAMED}`])
    other.close()
    await within(waiter.promise, 'waiter')
  }, 180_000)

  it('keeps retrying removal of an abandoned ticket through a write failure, so the next call goes once storage recovers', async ({
    slot
  }) => {
    const { run, queueRows, openQueue } = slot
    const holder = await run({ staleMs: 60_000 })
    const abandoned = run({ staleMs: 60_000 })
    await until(() => queueRows().some((row) => row.held_at === null), 'queued ticket')
    const ticket = queueRows().find((row) => row.held_at === null)
    const db = openQueue()
    const recover = failDeletes(db, ticket.id, 'keep_abandoned')
    abandoned.abort()
    await expect(abandoned).rejects.toThrow()
    const next = observe(run({ staleMs: 60_000 }))
    await holder()
    await delay(1500)
    // The abandoned ticket is still there and still checked in, so the next call waits behind it.
    expect(queueRows().find((row) => row.id === ticket.id)?.lane).toBe(0)
    expect(next.settled).toBe(false)
    recover()
    // Well inside the abandoned ticket's minute-long stale window.
    await within(next.promise, 'next call after storage recovered', 30_000)
    expect(queueRows().some((row) => row.id === ticket.id)).toBe(false)
  }, 180_000)

  it('stops waiting on an abandoned ticket whose removal keeps failing once it goes silent', async ({
    slot
  }) => {
    const { run, queueRows, openQueue } = slot
    const staleMs = 2000
    const holder = await run({ staleMs })
    const abandoned = run({ staleMs })
    await until(() => queueRows().some((row) => row.held_at === null), 'queued ticket')
    const ticket = queueRows().find((row) => row.held_at === null)
    const db = openQueue()
    const recover = failDeletes(db, ticket.id, 'keep_forever')
    abandoned.abort()
    await expect(abandoned).rejects.toThrow()
    const next = run({ staleMs })
    await holder()
    const release = await within(next, 'next call past the silent ticket')
    // The next call was admitted only once the abandoned ticket had gone silent: its decision
    // clock (held_at) is past the ticket's last check-in plus staleMs.
    const rows = queueRows()
    const lastCheckIn = Number(rows.find((row) => row.id === ticket.id).seen_at)
    const admittedAt = Number(rows.find((row) => row.held_at !== null).held_at)
    expect(admittedAt).toBeGreaterThan(lastCheckIn + staleMs)
    await release()
    // Removal gave up after staleMs; the ticket stays aside until it expires.
    await within(settleChangedCheckSlotCleanup(), 'removal giving up')
    expect(queueRows().find((row) => row.id === ticket.id)?.lane).toBe(2)
    recover()
  }, 180_000)
})
