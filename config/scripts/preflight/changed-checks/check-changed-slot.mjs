import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const slotDirectory = path.join(homedir(), '.cache', 'orca', 'preflight')
const slotFile = path.join(slotDirectory, `${hostname()}.sqlite`)
const WAITING = 'Waiting for another local check:changed run to finish…'
// Lanes, in turn order. A ticket that stops checking in is moved to SILENT once, out of every
// waiter's walk, and returns to its own lane when it checks in again.
const NORMAL = 0
const YIELDING = 1
const SILENT = 2
const LAST_ID = Number.MAX_SAFE_INTEGER
// Most tickets one decision may move or remove; the rest wait for the next poll.
const MAX_STEPS = 16
// Most expired tickets one decision may remove.
const EXPIRE_BATCH = 8
// Most queue entries one count reads; longer lines are reported as "100+".
const COUNT_CAP = 100
const MAX_ANCESTORS = 16
// Releases and ticket removals still in flight; tests await them before deleting files.
const pending = new Set()

function track(promise) {
  pending.add(promise)
  promise.finally(() => pending.delete(promise))
  return promise
}

/** Resolves once every release and ticket removal started by this process has settled, including ones started meanwhile. */
export async function settleChangedCheckSlotCleanup() {
  while (pending.size > 0) {
    await Promise.allSettled(pending)
  }
}

// The slot holder keeps a write transaction open on the slot file for its whole run, so waiters
// cannot write their tickets there. The queue lives in a sibling file with short transactions.
export function queueFileFor(file) {
  return `${file.replace(/\.sqlite$/, '')}.queue.sqlite`
}

/**
 * Admits one check:changed run per host, in the order runs joined the queue.
 *
 * Exclusion comes only from the SQLite write lock on `file`, which the OS drops when its holder
 * dies. The ticket queue decides which waiter may try for that lock: each poll reads the queue,
 * clears dead and silent tickets, and claims the lock inside one write transaction on the queue,
 * so a decision sees one committed state and its claim is published with it. A waiter adopts the
 * results of a decision only after that transaction commits.
 *
 * Turn order: the normal lane by arrival, then runs whose launcher has exited (a process up to
 * MAX_ANCESTORS levels above the run when it joined, found gone when probed every beatMs; this is
 * permanent for the request), then tickets that have not checked in for `staleMs`. A silent ticket
 * that checks in again within `expireMs` returns to its lane and place; after that it rejoins at
 * the back, whether or not its old row has been pruned yet. Order holds among runs using this
 * queue; older checkouts share the lock but not the order.
 *
 * The wait line reports what the waiter's last check of the queue showed. It never claims who
 * holds the lock now.
 *
 * If the queue cannot be used (it cannot be opened, set up or written with an error other than
 * busy), the waiter prints one warning, leaves the queue and waits for the slot directly with the
 * same BEGIN IMMEDIATE, as before the queue existed: exactly one run still holds the slot, but
 * that waiter no longer keeps its place in line.
 */
export async function acquireChangedCheckSlot(file = slotFile, options = {}) {
  const timing = timingFor(options.staleMs ?? 30_000, options.launcherCheckMs)
  const pollMs = options.pollMs ?? 1000
  const log = options.log ?? console.log
  const signal = options.signal
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  let lock
  let queue
  let waiter
  try {
    lock = new DatabaseSync(file)
    try {
      queue = new Queue(queueFileFor(file), timing)
      waiter = new Waiter(queue, describeSelf(options.ancestors), timing, log)
      // Test-only hooks: inside the decision transaction after the queue is read and before the
      // claim; after a committed decision and before its line is printed; on each recount.
      waiter.beforeClaim = options.beforeClaim
      waiter.beforeReport = options.beforeReport
      waiter.onRecount = options.onRecount
      for (;;) {
        signal?.throwIfAborted()
        // Polls before the first await, so an uncontended call joins the queue in call order.
        if (waiter.poll(lock)) {
          return holdSlot(lock, queue, waiter.id, waiter.token, timing)
        }
        await delay(pollMs, undefined, { signal })
      }
    } catch (error) {
      if (!(error instanceof QueueUnusable)) {
        throw error
      }
      queue?.removeEventually(waiter?.id, waiter?.token)
      const reason = String(error.cause?.message ?? error.cause)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200)
      log(`The check:changed queue could not be used (${reason}); waiting for the slot without it.`)
      return await waitDirectly(lock, pollMs, signal)
    }
  } catch (error) {
    closeQuietly(lock)
    queue?.removeEventually(waiter?.id, waiter?.token)
    throw error
  }
}

/** A queue failure other than busy: the waiter stops using the queue. */
class QueueUnusable extends Error {
  constructor(cause) {
    super('queue unusable', { cause })
  }
}

/** Waits for the slot the way runs did before the queue: the same lock, no place in line. */
async function waitDirectly(lock, pollMs, signal) {
  for (;;) {
    signal?.throwIfAborted()
    if (tryLock(lock)) {
      let releasing
      return () => {
        releasing ??= track(Promise.resolve().then(() => closeQuietly(lock)))
        return releasing
      }
    }
    await delay(pollMs, undefined, { signal })
  }
}

function timingFor(staleMs, launcherCheckMs = staleMs / 3) {
  return {
    staleMs,
    // How often a normal-lane waiter probes its launchers (tests shorten it).
    launcherCheckMs,
    // Waiters check in, recount and probe launchers at this cadence while they can poll.
    beatMs: staleMs / 3,
    // A holder is named only while its last heartbeat, read when the line is printed, is this recent.
    holderFreshMs: staleMs / 5,
    holderBeatMs: staleMs / 15,
    // A ticket that has not checked in for this long has lost its place: it is removed, and if
    // its owner returns first it rejoins at the back.
    expireMs: staleMs * 10
  }
}

class Waiter {
  constructor(queue, self, timing, log) {
    this.queue = queue
    this.self = self
    this.timing = timing
    this.log = log
    // Binds every write and removal to this request, so a reused id can never be mistaken for it.
    this.token = randomUUID()
    this.lane = NORMAL
    this.lastAncestorCheck = 0
    this.lastNotice = ''
    // Committed state, adopted only after a decision's transaction commits.
    this.id = undefined
    this.lastBeat = 0
    this.view = {
      place: undefined,
      blocker: undefined,
      holder: undefined,
      lane: NORMAL,
      capped: false,
      at: 0
    }
  }

  /** One coherent decision under the queue's write lock; true once the slot is held. */
  poll(lock) {
    const now = Date.now()
    if (this.lane === NORMAL && now - this.lastAncestorCheck >= this.timing.launcherCheckMs) {
      this.lastAncestorCheck = now
      if (this.self.ancestors.some((pid) => processGone(pid))) {
        this.lane = YIELDING
        this.log(
          'A process that started this check has exited; runs whose launchers are still running go first.'
        )
      }
    }
    const claim = { locked: false }
    let outcome
    try {
      if (!this.queue.setup()) {
        return false
      }
      // A busy queue skips this poll: no decision is made from unavailable or unrefreshed state.
      outcome = attempt(() => transaction(this.queue.db, () => this.decide(lock, claim)))
    } catch (error) {
      releaseClaim(lock, claim)
      if (claim.error === error) {
        throw error
      }
      throw new QueueUnusable(error)
    }
    if (outcome === undefined) {
      releaseClaim(lock, claim)
      return false
    }
    this.id = outcome.id
    this.lastBeat = outcome.lastBeat
    this.view = outcome.view
    if (outcome.held) {
      return true
    }
    this.beforeReport?.()
    this.report(outcome)
    return false
  }

  decide(lock, claim) {
    const s = this.queue.statements
    const { staleMs, beatMs, expireMs } = this.timing
    // Every threshold in this decision and the claim time use this one clock read.
    const now = Date.now()
    let id = this.id
    let lastBeat = this.lastBeat
    let own = id === undefined ? undefined : s.own.get(id, this.token)
    if (own !== undefined && own.seen_at < now - expireMs) {
      // Past the expiry horizon this ticket has lost its place, even if no one has pruned it yet.
      s.removeOwn.run(id, this.token)
      own = undefined
    }
    if (own === undefined) {
      // Never joined, or this ticket was removed: join at the back.
      id = Number(
        s.insert.run(this.token, this.self.pid, this.self.cwd, now, now, this.lane).lastInsertRowid
      )
      lastBeat = now
    } else if (own.lane !== this.lane || now - lastBeat >= beatMs) {
      s.beat.run(now, this.lane, id, this.token)
      lastBeat = now
    }
    // Oldest first, at most EXPIRE_BATCH per decision.
    s.expire.run(now - expireMs, id, EXPIRE_BATCH)

    // Walk to the nearest ticket whose turn comes before ours. Each dead ticket met is removed and
    // each silent one moved aside, at most MAX_STEPS per decision, so later walks never revisit them.
    let blocker
    let capped = false
    let steps = 0
    const lanes =
      this.lane === NORMAL
        ? [[NORMAL, id]]
        : [
            [NORMAL, LAST_ID],
            [YIELDING, id]
          ]
    walk: for (const [lane, before] of lanes) {
      for (let row = s.ahead.get(lane, before); row; row = s.ahead.get(lane, before)) {
        if (steps === MAX_STEPS) {
          // More to clear than one decision may do: not first yet; the next poll continues.
          blocker = row
          capped = true
          break walk
        }
        steps += 1
        if (processGone(row.pid)) {
          s.remove.run(row.id)
        } else if (row.seen_at < now - staleMs) {
          s.silence.run(SILENT, row.id)
        } else {
          blocker = row
          break walk
        }
      }
    }

    if (blocker === undefined) {
      this.beforeClaim?.()
      let locked
      try {
        locked = tryLock(lock)
      } catch (error) {
        claim.error = error
        throw error
      }
      if (locked) {
        claim.locked = true
        s.hold.run(now, now, id, this.token)
        // Only one connection can hold the slot lock, so any other held ticket is left over.
        s.removeOtherHeld.run(id)
        return { id, lastBeat, view: this.view, held: true }
      }
    }

    const holder = s.holder.get()
    const previous = this.view
    // A blocker met only because the walk hit MAX_STEPS is provisional: it changes with every
    // batch of a backlog, so it must not trigger a recount.
    const blockerId = capped ? previous.blocker : blocker?.id
    let place = previous.place
    let at = previous.at
    if (
      place === undefined ||
      (previous.capped && !capped) ||
      blockerId !== previous.blocker ||
      holder?.id !== previous.holder ||
      this.lane !== previous.lane ||
      now - previous.at >= beatMs
    ) {
      // Reading one entry past the cap tells "exactly 100" from "more than 100".
      const count = (lane, before) => s.count.get(lane, before, COUNT_CAP + 1).n
      const parts =
        this.lane === NORMAL ? [count(NORMAL, id)] : [count(NORMAL, LAST_ID), count(YIELDING, id)]
      const totals = [count(NORMAL, LAST_ID), count(YIELDING, LAST_ID)]
      this.onRecount?.()
      const ahead = parts.reduce((sum, n) => sum + n, 0)
      const total = totals.reduce((sum, n) => sum + n, 0)
      place = {
        position: ahead + 1,
        total,
        positionCapped: parts.some((n) => n > COUNT_CAP),
        totalCapped: totals.some((n) => n > COUNT_CAP)
      }
      at = now
    }
    return {
      id,
      lastBeat,
      held: false,
      first: blocker === undefined,
      holder,
      view: { place, blocker: blockerId, holder: holder?.id, lane: this.lane, capped, at }
    }
  }

  report({ first, holder }) {
    const { position, total, positionCapped, totalCapped } = this.view.place
    // The line reports what this waiter's last check of the queue showed; the queue cannot prove
    // who holds the lock now. A holder is shown only if its pid is alive and, by the clock at
    // print time, its last heartbeat is recent and not in the future (which a clock step would
    // make unprovable). A holder that released has stopped heartbeating.
    const now = Date.now()
    const age = holder === undefined ? undefined : now - holder.seen_at
    const shown =
      age !== undefined && age >= 0 && age < this.timing.holderFreshMs && !processGone(holder.pid)
    const over = `over ${COUNT_CAP}`
    const place = `${WAITING} Position ${positionCapped ? over : position} of ${totalCapped ? over : total}.`
    // Keyed on what is shown, so a correction that keeps the same numbers is still printed.
    const notice = `${place}/${shown ? holder.id : first ? 'unnamed' : ''}`
    if (notice === this.lastNotice) {
      return
    }
    this.lastNotice = notice
    if (shown) {
      const where = holder.cwd ? ` in ${holder.cwd}` : ''
      this.log(
        `${place} The queue last showed pid ${holder.pid}${where} holding the slot, claimed ${formatAge(now - holder.held_at)} ago.`
      )
    } else if (first) {
      this.log(
        `${place} The slot was held by a run the queue cannot name, such as one from an older checkout.`
      )
    } else {
      this.log(place)
    }
  }
}

function holdSlot(lock, queue, id, token, timing) {
  // Metadata only: a failing heartbeat must never end or disturb the check holding the slot.
  const timer = setInterval(() => {
    try {
      if (queue.beatHeld(id, token) === 0) {
        clearInterval(timer)
      }
    } catch {
      clearInterval(timer)
    }
  }, timing.holderBeatMs)
  timer.unref()
  let releasing
  // Resolves once the slot is unlocked; it never rejects, and callers may ignore it.
  return () => {
    releasing ??= track(new Promise((resolve) => release(resolve)))
    return releasing
  }

  function release(resolve) {
    clearInterval(timer)
    // With a steady wall clock, this deadline also outlasts the last heartbeat's naming window.
    const deadline = performance.now() + timing.holderFreshMs
    const unlock = () => {
      closeQuietly(lock)
    }
    const step = () => {
      let removed
      try {
        removed = queue.removeHeld(id, token)
      } catch {
        removed = false
      }
      if (removed === true) {
        // The ticket is gone before the slot frees, so no waiter sees a free slot still listed.
        unlock()
        queue.close()
        resolve()
        return
      }
      if (removed === undefined && performance.now() < deadline) {
        // Keeps the process alive for at most holderFreshMs.
        setTimeout(step, Math.min(100, timing.holderFreshMs))
        return
      }
      // Wait out the normal naming window without letting a wall-clock step extend ownership.
      setTimeout(
        () => {
          unlock()
          queue.removeEventually(id, token)
          resolve()
        },
        Math.max(0, deadline - performance.now())
      )
    }
    step()
  }
}

class Queue {
  constructor(file, timing) {
    // Short, so a stalled peer costs one poll; busy work is retried on a later poll.
    try {
      this.db = new DatabaseSync(file, { timeout: 100 })
    } catch (error) {
      throw new QueueUnusable(error)
    }
    this.timing = timing
    this.statements = undefined
    this.closed = false
    this.removal = undefined
  }

  setup() {
    if (this.statements) {
      return true
    }
    return (
      attempt(() => {
        // Tickets need no durability across a power loss, so WAL with NORMAL sync keeps check-in
        // commits off fsync while staying safe from corruption.
        this.db.exec('PRAGMA journal_mode = WAL')
        this.db.exec('PRAGMA synchronous = NORMAL')
        transaction(this.db, () =>
          this.db.exec(`CREATE TABLE IF NOT EXISTS tickets_v4 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL,
            pid INTEGER NOT NULL,
            cwd TEXT NOT NULL,
            enqueued_at INTEGER NOT NULL,
            seen_at INTEGER NOT NULL,
            lane INTEGER NOT NULL,
            held_at INTEGER
          );
          CREATE INDEX IF NOT EXISTS tickets_v4_lane ON tickets_v4 (lane, id) WHERE held_at IS NULL;
          CREATE INDEX IF NOT EXISTS tickets_v4_held ON tickets_v4 (id) WHERE held_at IS NOT NULL;
          CREATE INDEX IF NOT EXISTS tickets_v4_seen ON tickets_v4 (seen_at)
            WHERE held_at IS NULL;`)
        )
        this.statements = prepareStatements(this.db)
        return true
      }) ?? false
    )
  }

  /** Rows changed, or undefined when busy. */
  beatHeld(id, token) {
    return attempt(() => Number(this.statements.beatHeld.run(Date.now(), id, token).changes))
  }

  /** True once the held ticket's removal commits; undefined when busy; throws on other errors. */
  removeHeld(id, token) {
    if (this.closed) {
      return false
    }
    return attempt(() =>
      transaction(this.db, () => {
        this.statements.removeOwn.run(id, token)
        return true
      })
    )
  }

  /**
   * Removes this request's ticket in the background, then closes. Busy is retried every 250 ms
   * until it succeeds; other errors are retried every second for staleMs, after which the ticket,
   * no longer checking in, has stopped holding anyone up and later expires. Timers do not keep the
   * process alive; if the process exits, its pid marks the ticket dead.
   */
  removeEventually(id, token) {
    if (this.closed) {
      return
    }
    const startedAt = Date.now()
    this.removal ??= track(
      new Promise((resolve) => {
        const step = () => {
          let done
          let retryMs = 250
          try {
            done =
              id === undefined || this.statements === undefined
                ? true
                : attempt(() => {
                    this.statements.removeOwn.run(id, token)
                    return true
                  })
          } catch {
            done = Date.now() - startedAt >= this.timing.staleMs ? true : undefined
            retryMs = 1000
          }
          if (done) {
            this.close()
            resolve()
            return
          }
          setTimeout(step, retryMs).unref()
        }
        step()
      })
    )
  }

  close() {
    if (!this.closed) {
      this.closed = true
      closeQuietly(this.db)
    }
  }
}

function prepareStatements(db) {
  const columns = 'id, pid, cwd, seen_at, lane, held_at'
  return {
    insert: db.prepare(
      'INSERT INTO tickets_v4 (token, pid, cwd, enqueued_at, seen_at, lane) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    own: db.prepare(
      'SELECT lane, seen_at FROM tickets_v4 WHERE id = ? AND token = ? AND held_at IS NULL'
    ),
    beat: db.prepare('UPDATE tickets_v4 SET seen_at = ?, lane = ? WHERE id = ? AND token = ?'),
    expire: db.prepare(
      `DELETE FROM tickets_v4 WHERE id IN (
         SELECT id FROM tickets_v4 INDEXED BY tickets_v4_seen
         WHERE held_at IS NULL AND seen_at < ? AND id <> ? ORDER BY seen_at LIMIT ?)`
    ),
    ahead: db.prepare(
      `SELECT ${columns} FROM tickets_v4 INDEXED BY tickets_v4_lane
       WHERE held_at IS NULL AND lane = ? AND id < ? ORDER BY id DESC LIMIT 1`
    ),
    count: db.prepare(
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM tickets_v4 INDEXED BY tickets_v4_lane
       WHERE held_at IS NULL AND lane = ? AND id < ? LIMIT ?)`
    ),
    silence: db.prepare('UPDATE tickets_v4 SET lane = ? WHERE id = ?'),
    holder: db.prepare(
      `SELECT ${columns} FROM tickets_v4 INDEXED BY tickets_v4_held
       WHERE held_at IS NOT NULL ORDER BY id DESC LIMIT 1`
    ),
    hold: db.prepare('UPDATE tickets_v4 SET held_at = ?, seen_at = ? WHERE id = ? AND token = ?'),
    beatHeld: db.prepare(
      'UPDATE tickets_v4 SET seen_at = ? WHERE id = ? AND token = ? AND held_at IS NOT NULL'
    ),
    removeOtherHeld: db.prepare('DELETE FROM tickets_v4 WHERE held_at IS NOT NULL AND id <> ?'),
    remove: db.prepare('DELETE FROM tickets_v4 WHERE id = ?'),
    removeOwn: db.prepare('DELETE FROM tickets_v4 WHERE id = ? AND token = ?')
  }
}

function isBusy(error) {
  // SQLITE_BUSY (5), SQLITE_LOCKED (6) and SQLITE_PROTOCOL (15, WAL lock retries exhausted under
  // heavy contention), including their extended codes: all clear once the other connections move on.
  const code = error?.errcode & 0xff
  return code === 5 || code === 6 || code === 15
}

/** Runs `body`, returning undefined instead of throwing when SQLite reports the database busy or locked. */
function attempt(body) {
  try {
    return body()
  } catch (error) {
    if (isBusy(error)) {
      return undefined
    }
    throw error
  }
}

function transaction(db, body) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = body()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) {
      db.exec('ROLLBACK')
    }
    throw error
  }
}

function tryLock(lock) {
  try {
    // SQLite releases the write lock even when a check is killed.
    lock.exec('BEGIN IMMEDIATE')
    return true
  } catch (error) {
    if (!isBusy(error)) {
      throw error
    }
    return false
  }
}

/** Gives the slot back after a claim whose queue transaction did not commit. */
function releaseClaim(lock, claim) {
  if (!claim.locked) {
    return
  }
  try {
    if (lock.isTransaction) {
      lock.exec('ROLLBACK')
    }
  } catch {
    closeQuietly(lock)
  }
}

function closeQuietly(db) {
  try {
    if (db?.isOpen) {
      db.close()
    }
  } catch {
    // Closing is best effort on a path that is already failing or finished.
  }
}

export function formatAge(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** True only when the OS says no such process; any other answer counts as still running. */
function processGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return true
  }
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error.code === 'ESRCH'
  }
}

function currentDirectory() {
  try {
    return process.cwd()
  } catch {
    return ''
  }
}

/**
 * This process's launchers: the processes above it when it queues, up to MAX_ANCESTORS levels,
 * stopping at init or at the first link that cannot be read. One ps call per acquisition on
 * macOS (none on Linux); nothing is inferred when it fails.
 */
function describeSelf(ancestors) {
  const self = { pid: process.pid, cwd: currentDirectory(), ancestors }
  if (ancestors !== undefined) {
    return self
  }
  let parentOf
  if (process.platform === 'linux') {
    parentOf = (pid) => {
      try {
        const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
        // The command name can hold spaces and parentheses; fields resume after the last ')'.
        return Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[1]) || 0
      } catch {
        return 0
      }
    }
  } else {
    const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 })
    const parents = new Map()
    if (result.status === 0) {
      for (const line of result.stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
        if (match) {
          parents.set(Number(match[1]), Number(match[2]))
        }
      }
    }
    parentOf = (pid) => parents.get(pid) ?? 0
  }
  self.ancestors = []
  for (
    let pid = process.ppid;
    pid > 1 && self.ancestors.length < MAX_ANCESTORS;
    pid = parentOf(pid)
  ) {
    if (self.ancestors.includes(pid)) {
      break
    }
    self.ancestors.push(pid)
  }
  return self
}
