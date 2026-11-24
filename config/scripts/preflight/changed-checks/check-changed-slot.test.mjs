import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { queueFileFor } from './check-changed-slot.mjs'
import {
  createQueue,
  exitedPid,
  file,
  insertTicket,
  observe,
  openQueue,
  queueRows,
  root,
  run,
  spawnOwned,
  queueWriter,
  until,
  registerSlotHarness,
  within
} from './check-changed-slot.test-harness.mjs'

registerSlotHarness()

// Production Windows runs check:changed concurrently and never loads the slot; these tests need POSIX ps or /proc.
describe.skipIf(process.platform === 'win32')('check:changed slot queue order', () => {
  it('admits waiters one at a time in arrival order, whatever their poll rate', async () => {
    const holder = await run()
    const order = []
    let active = 1
    const waiters = Array.from({ length: 6 }, (_, index) =>
      // Earlier waiters poll slower, so retry timing alone would let later ones jump ahead.
      run({ pollMs: 60 - index * 10 }, async (release) => {
        active += 1
        order.push({ index, overlapping: active !== 1 })
        await delay(15)
        active -= 1
        await release()
      })
    )
    await delay(80)
    expect(order).toEqual([])
    active -= 1
    await holder()
    await within(Promise.all(waiters), 'all waiters')
    expect(order).toEqual([0, 1, 2, 3, 4, 5].map((index) => ({ index, overlapping: false })))
    expect(queueRows()).toEqual([])
  }, 180_000)

  it('serves an earlier slow waiter before a stream of fast newcomers', async () => {
    const holder = await run()
    const order = []
    const slow = run({ pollMs: 100 }, (release) => {
      order.push('slow')
      return release
    })
    const newcomers = [0, 1, 2].map((index) =>
      run({ pollMs: 1 }, (release) => {
        order.push(`new${index}`)
        return release()
      })
    )
    await holder()
    const releaseSlow = await within(slow, 'slow waiter')
    const late = run({ pollMs: 1 }, (release) => {
      order.push('late')
      return release()
    })
    await delay(30)
    expect(order).toEqual(['slow'])
    await releaseSlow()
    await within(Promise.all([...newcomers, late]), 'newcomers')
    expect(order).toEqual(['slow', 'new0', 'new1', 'new2', 'late'])
  }, 180_000)

  it('keeps separate processes exclusive when they all start on a cold queue at once', async () => {
    const children = Array.from({ length: 4 }, () =>
      spawnOwned(`const release = await acquireChangedCheckSlot(file, { pollMs: 5, ancestors: [], log: () => {} })
const start = Date.now()
await new Promise((resolve) => setTimeout(resolve, 40))
const end = Date.now()
await release()
process.stdout.write(JSON.stringify({ start, end }) + '\\n')
process.exit(0)`)
    )
    const results = await within(
      Promise.all(children.map(({ closed }) => closed)),
      'cold-start children',
      45_000
    )
    expect(results.map(({ code }) => code)).toEqual([0, 0, 0, 0])
    const intervals = children
      .map(({ output }) => JSON.parse(output()))
      .sort((a, b) => a.start - b.start)
    for (let index = 1; index < intervals.length; index++) {
      expect(intervals[index].start).toBeGreaterThanOrEqual(intervals[index - 1].end)
    }
  }, 240_000)

  it('admits separate processes in the order they queued', async () => {
    const holder = await run()
    const orderFile = join(root, 'order.txt')
    const children = []
    for (const name of ['a', 'b', 'c']) {
      const child = spawnOwned(`const release = await acquireChangedCheckSlot(file, {
  pollMs: 5,
  ancestors: [],
  log: () => process.stdout.write('waiting\\n')
})
appendFileSync(${JSON.stringify(orderFile)}, ${JSON.stringify(name)} + '\\n')
await new Promise((resolve) => setTimeout(resolve, 20))
await release()
process.exit(0)`)
      await child.waitFor('waiting')
      children.push(child)
    }
    await holder()
    const results = await within(
      Promise.all(children.map(({ closed }) => closed)),
      'children',
      45_000
    )
    expect(results.map(({ code }) => code)).toEqual([0, 0, 0])
    expect(await readFile(orderFile, 'utf8')).toBe('a\nb\nc\n')
  }, 240_000)

  it('removes the ticket of a waiter whose process is gone', async () => {
    const holder = await run()
    const dead = insertTicket({ pid: await exitedPid() })
    const waiter = run()
    await holder()
    // Half the 30 s stale window: passing by staleness instead of removal would take longer.
    await within(waiter, 'waiter behind a dead ticket', 15_000)
    expect(queueRows().map((row) => row.id)).not.toContain(dead)
  }, 180_000)

  it('stops a silent ticket holding up the line at once and removes it once expired, whoever owns its pid', async () => {
    const holder = await run()
    const staleMs = 1000
    // A pid that is alive but no longer checking in, as when the waiter stopped or its pid now
    // belongs to another process: nothing about the process itself is trusted.
    const expired = insertTicket({ pid: process.pid, seenAt: Date.now() - 10 * staleMs - 60_000 })
    const recent = insertTicket({ pid: process.pid, seenAt: Date.now() - 2 * staleMs })
    const waiter = observe(run({ staleMs }))
    await until(
      () =>
        queueRows()
          .filter((row) => [expired, recent].includes(row.id))
          .every((row) => row.lane === 2),
      'silent tickets moved aside'
    )
    await until(() => !queueRows().some((row) => row.id === expired), 'expired ticket removed')
    expect(queueRows().find((row) => row.id === recent)?.lane).toBe(2)
    expect(waiter.settled).toBe(false)
    await holder()
    await within(waiter.promise, 'waiter')
  }, 180_000)

  it('expires a silent backlog larger than one batch, shared by whichever waiters are polling', async () => {
    const holder = await run()
    const long = Date.now() - 60 * 60_000
    for (let index = 0; index < 40; index++) {
      insertTicket({ pid: process.pid, seenAt: long, lane: 2 })
    }
    // Expiry is a shared index walk, not a per-waiter cursor: any polling waiter advances it.
    const first = observe(run({ staleMs: 1000 }))
    const second = observe(run({ staleMs: 1000 }))
    await until(() => queueRows().every((row) => row.lane !== 2), 'whole backlog expired')
    expect(first.settled || second.settled).toBe(false)
    await holder()
    await within(first.promise, 'first waiter')
  }, 180_000)

  it('clears at most a bounded number of tickets per decision and still gets through a backlog', async () => {
    const holder = await run()
    const dead = await exitedPid()
    for (let index = 0; index < 40; index++) {
      insertTicket({ pid: dead })
    }
    // One poll only: the first decision runs synchronously, the next would be an hour later.
    const once = run({ pollMs: 60 * 60_000 })
    expect(queueRows().filter((row) => row.pid === dead)).toHaveLength(40 - 16)
    once.abort()
    await expect(once).rejects.toThrow()
    const waiter = observe(run())
    await until(() => !queueRows().some((row) => row.pid === dead), 'dead backlog removed')
    expect(waiter.settled).toBe(false)
    await holder()
    await within(waiter.promise, 'waiter')
  }, 180_000)

  it('recounts its place as soon as it starts yielding, with the same run ahead and holder', async () => {
    // Timed recounts and launcher probes both run every staleMs / 3 = 20 s.
    const staleMs = 60_000
    const holder = await run({ staleMs })
    run({ staleMs })
    run({ staleMs, ancestors: [await exitedPid()] })
    const launcher = spawnOwned('await next()')
    await launcher.waitFor('')
    // The waiter probes its launcher on its first poll but cannot join until the writer leaves,
    // so its first count, and so its timed recounts, run 10 s behind its launcher probes.
    const writer = await queueWriter()
    const messages = []
    const waiter = observe(
      run({
        staleMs,
        ancestors: [launcher.pid],
        log: (message) => messages.push({ message, at: Date.now() })
      })
    )
    await delay(10_000)
    await writer.kill()
    await until(() => messages.length > 0, 'first message')
    expect(messages[0].message).toContain('Position 2 of 3.')
    await launcher.kill()
    await until(
      () => messages.some(({ message }) => message.includes('has exited')),
      'launcher exit noticed',
      40_000
    )
    const exited = messages.find(({ message }) => message.includes('has exited'))
    await until(
      () =>
        messages.some(({ message, at }) => at >= exited.at && message.includes('Position 3 of 3.')),
      'recount after yielding',
      20_000
    )
    const recount = messages.find(
      ({ message, at }) => at >= exited.at && message.includes('Position 3 of 3.')
    )
    // A timed recount would come about 10 s later; only the lane change explains this one.
    expect(recount.at - exited.at).toBeLessThan(2000)
    await holder()
    expect(waiter.settled).toBe(false)
  }, 240_000)

  it('passes a live waiter only once it has been silent for staleMs', async () => {
    await createQueue()
    const staleMs = 1500
    const seenAt = Date.now()
    insertTicket({ pid: process.pid, seenAt })
    const release = await within(run({ staleMs }), 'waiter behind a silent ticket')
    // held_at is the clock reading the admission decision compared against, taken inside the
    // queue transaction that claimed the slot, so a late-running test cannot hide an early admission.
    const held = queueRows().find((row) => row.held_at !== null)
    expect(held.held_at).toBeGreaterThan(seenAt + staleMs)
    await release()
  }, 180_000)

  it('lets a fresh yielding waiter pass an earlier stopped waiter', async () => {
    const holder = await run()
    const stopped = insertTicket({
      pid: process.pid,
      seenAt: Date.now() - 2 * 60_000
    })
    const yielding = run({ ancestors: [await exitedPid()], staleMs: 60_000 })
    await holder()
    await within(yielding, 'yielding waiter')
    expect(queueRows().map((row) => row.id)).toContain(stopped)
  }, 180_000)

  for (const { yields, label } of [
    { yields: false, label: 'a silent ticket ahead in the same lane' },
    { yields: true, label: 'a normal ticket while the waiter yields' }
  ]) {
    it(`decides only on committed queue state: ${label} checks in mid-decision`, async () => {
      const holder = await run()
      const ancestors = yields ? [await exitedPid()] : []
      // The peer's ticket is queued silent (stale, not yet expired) and ahead of the waiter, which
      // moves it aside.
      const peer = spawnOwned(`const db = new DatabaseSync(queueFile, { timeout: 5000 })
const id = Number(db.prepare(
  'INSERT INTO tickets_v3 (token, pid, cwd, enqueued_at, seen_at, lane) VALUES (\\'peer\\', ?, ?, ?, ?, 0)'
).run(process.pid, process.cwd(), Date.now() - 120_000, Date.now() - 120_000).lastInsertRowid)
process.stdout.write('queued\\n')
await next()
db.exec('BEGIN IMMEDIATE')
db.prepare('UPDATE tickets_v3 SET seen_at = ?, lane = 0 WHERE id = ?').run(Date.now(), id)
process.stdout.write('refreshing\\n')
await next()
db.exec('COMMIT')
process.stdout.write('committed\\n')
await next()
db.prepare('DELETE FROM tickets_v3 WHERE id = ?').run(id)
process.stdout.write('left\\n')
await next()`)
      await peer.waitFor('queued')
      const waiter = observe(run({ ancestors, staleMs: 60_000 }))
      await until(
        () => queueRows().some((row) => row.pid === peer.pid && row.lane === 2),
        'peer ticket moved aside'
      )
      // The peer checks in again inside an open transaction while the slot frees up.
      peer.send('refresh')
      await peer.waitFor('refreshing')
      const released = holder()
      await delay(300)
      expect(waiter.settled).toBe(false)
      peer.send('commit')
      await peer.waitFor('committed')
      await within(released, 'holder release')
      await delay(300)
      // The committed check-in puts the peer ahead again, so the free slot still waits for it.
      expect(waiter.error).toBeUndefined()
      expect(waiter.settled).toBe(false)
      peer.send('leave')
      await peer.waitFor('left')
      await within(waiter.promise, 'waiter after the peer left')
      expect(waiter.error).toBeUndefined()
    }, 240_000)
  }

  it('lets no check-in commit between reading the queue and claiming the slot', async () => {
    await createQueue()
    const peer = insertTicket({ pid: process.pid, seenAt: 1 })
    const attempts = []
    const release = await within(
      run({
        // Inside the decision: the peer's ticket was just read as silent. A check-in for it now
        // must not commit, or the claim would rest on a state that no longer holds.
        beforeClaim: () => {
          const other = new DatabaseSync(queueFileFor(file), { timeout: 0 })
          try {
            other
              .prepare('UPDATE tickets_v3 SET seen_at = ?, lane = 0 WHERE id = ?')
              .run(Date.now(), peer)
            attempts.push('committed')
          } catch (error) {
            attempts.push(error.errcode & 0xff)
          } finally {
            other.close()
          }
        }
      }),
      'waiter'
    )
    // SQLITE_BUSY: the decision holds the queue's write lock until the claim commits.
    expect(attempts).toEqual([5])
    await release()
  }, 180_000)

  it('moves a waiter behind the line when its launcher has exited', async () => {
    const holder = await run()
    const order = []
    const messages = []
    const orphan = run(
      { ancestors: [await exitedPid()], log: (message) => messages.push(message) },
      (release) => {
        order.push('orphan')
        return release()
      }
    )
    const launched = run({}, (release) => {
      order.push('launched')
      return release()
    })
    await holder()
    await within(Promise.all([orphan, launched]), 'both waiters')
    expect(order).toEqual(['launched', 'orphan'])
    expect(messages[0]).toContain('has exited')
  }, 180_000)

  it('rejoins at the back when its ticket is removed', async () => {
    const holder = await run()
    const order = []
    const first = run({}, (release) => {
      order.push('first')
      return release()
    })
    await until(() => queueRows().some((row) => row.held_at === null), 'first ticket')
    const firstTicket = queueRows().find((row) => row.held_at === null)
    const second = run({}, (release) => {
      order.push('second')
      return release()
    })
    const db = openQueue()
    db.prepare('DELETE FROM tickets_v3 WHERE id = ?').run(firstTicket.id)
    await until(
      () => queueRows().filter((row) => row.held_at === null).length === 2,
      'first ticket rejoining'
    )
    await holder()
    await within(Promise.all([first, second]), 'both waiters')
    expect(order).toEqual(['second', 'first'])
  }, 180_000)
})
