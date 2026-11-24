import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const slotDirectory = path.join(homedir(), '.cache', 'orca', 'preflight')
const slotFile = path.join(slotDirectory, `${hostname()}.sqlite`)
const WAITING = 'Waiting for another local check:changed run to finish…'
// Lanes, in turn order. A silent ticket is moved to its own lane once, so no waiter re-reads it every poll.
const NORMAL = 0
const YIELDING = 1
const SILENT = 2
const LAST_ID = Number.MAX_SAFE_INTEGER
const SWEEP_LIMIT = 32
const MAX_ANCESTORS = 16
let ownStart
// Background ticket removals and releases still in flight; tests await them before deleting files.
const pending = new Set()

function track(promise) {
  pending.add(promise)
  promise.finally(() => pending.delete(promise))
  return promise
}

/** Resolves once every background ticket removal and release started by this process has settled. */
export function settleChangedCheckSlotCleanup() {
  return Promise.all(pending)
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
 * removes dead tickets, and claims the lock inside one write transaction on the queue, so the
 * decision sees one committed state and a claim is published with it.
 *
 * Turn order: tickets in the normal lane by arrival, then tickets whose launcher has exited (any
 * process up to 16 levels above the run when it queued, seen gone when probed), then tickets that
 * have not checked in for `staleMs`. A run that checks in again returns to its lane and place.
 */
export async function acquireChangedCheckSlot(file = slotFile, options = {}) {
  const timing = timingFor(options.staleMs ?? 30_000)
  const pollMs = options.pollMs ?? 1000
  const log = options.log ?? console.log
  const signal = options.signal
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  let lock
  let queue
  let waiter
  try {
    lock = new DatabaseSync(file)
    queue = new Queue(queueFileFor(file))
    waiter = new Waiter(queue, describeSelf(options.ancestors), timing, log)
    // Test-only: runs inside the decision transaction, after the queue is read and before the claim.
    waiter.beforeClaim = options.beforeClaim
    for (;;) {
      signal?.throwIfAborted()
      // Polls before the first await, so an uncontended call joins the queue in call order.
      const heldAt = waiter.poll(lock)
      if (heldAt !== undefined) {
        return holdSlot(lock, queue, waiter.id, timing)
      }
      waiter.sweepSilent()
      await delay(pollMs, undefined, { signal })
    }
  } catch (error) {
    closeQuietly(lock)
    queue?.removeEventually(waiter?.id)
    throw error
  }
}

function timingFor(staleMs) {
  return {
    staleMs,
    // Waiters check in, recount their place and probe launchers at this cadence.
    beatMs: staleMs / 3,
    // A holder is named only while its heartbeat is this recent.
    holderFreshMs: staleMs / 5,
    holderBeatMs: staleMs / 15
  }
}

class Waiter {
  constructor(queue, self, timing, log) {
    this.queue = queue
    this.self = self
    this.timing = timing
    this.log = log
    this.id = undefined
    this.lane = NORMAL
    this.lastBeat = 0
    this.lastAncestorCheck = 0
    this.lastCount = 0
    this.lastBlocker = undefined
    this.lastHolder = undefined
    this.place = undefined
    this.first = false
    this.lastSweep = 0
    this.sweepAfter = 0
    this.lastNotice = ''
  }

  /** One coherent decision under the queue's write lock; returns the claim time once the slot is held. */
  poll(lock) {
    const now = Date.now()
    if (this.lane === NORMAL && now - this.lastAncestorCheck >= this.timing.beatMs) {
      this.lastAncestorCheck = now
      if (this.self.ancestors.some((pid) => processGone(pid))) {
        this.lane = YIELDING
        this.log(
          'A process that started this check has exited; runs whose launchers are still running go first.'
        )
      }
    }
    if (!this.queue.setup()) {
      return undefined
    }
    let claimed = false
    let decision
    try {
      // A busy queue skips this poll entirely: no decision is made from partial or unrefreshed state.
      decision = attempt(() =>
        transaction(this.queue.db, () => {
          const result = this.decide(lock)
          claimed = result.heldAt !== undefined
          return result
        })
      )
    } catch (error) {
      if (claimed) {
        endSlotTransaction(lock)
      }
      throw error
    }
    if (decision === undefined) {
      if (claimed) {
        endSlotTransaction(lock)
      }
      return undefined
    }
    if (decision.heldAt !== undefined) {
      return decision.heldAt
    }
    this.report(decision)
    return undefined
  }

  decide(lock) {
    const s = this.queue.statements
    const { staleMs, beatMs } = this.timing
    // Sampled inside the transaction: every threshold below and the claim time use this one clock read.
    const now = Date.now()
    const own = this.id === undefined ? undefined : s.own.get(this.id)
    if (own === undefined) {
      // Never joined, or another waiter removed this ticket: join at the back.
      this.id = Number(
        s.insert.run(this.self.pid, this.self.started, this.self.cwd, now, now, this.lane)
          .lastInsertRowid
      )
      this.lastBeat = now
    } else if (own.lane !== this.lane || now - this.lastBeat >= beatMs) {
      s.beat.run(now, this.lane, this.id)
      this.lastBeat = now
    }

    // Walk to the nearest ticket whose turn comes before ours. Each dead or silent ticket met is
    // removed or moved to the silent lane in this transaction, so later polls never revisit it.
    let blocker
    const lanes =
      this.lane === NORMAL
        ? [[NORMAL, this.id]]
        : [
            [NORMAL, LAST_ID],
            [YIELDING, this.id]
          ]
    for (const [lane, before] of lanes) {
      for (let row = s.ahead.get(lane, before); row; row = s.ahead.get(lane, before)) {
        if (processGone(row.pid)) {
          s.remove.run(row.id)
        } else if (row.seen_at < now - staleMs) {
          s.silence.run(SILENT, row.id)
        } else {
          blocker = row
          break
        }
      }
      if (blocker) {
        break
      }
    }
    this.first = blocker === undefined
    if (this.first) {
      this.beforeClaim?.()
    }

    if (this.first && tryLock(lock)) {
      s.hold.run(now, now, this.id)
      // Only one connection can hold the slot lock, so any other held ticket is left over.
      s.removeOtherHeld.run(this.id)
      return { heldAt: now }
    }

    const holderRow = s.holder.get()
    const holder =
      holderRow &&
      holderRow.seen_at >= now - this.timing.holderFreshMs &&
      !processGone(holderRow.pid)
        ? holderRow
        : undefined
    // The line moves when someone is admitted or the ticket ahead leaves; recount then, and at
    // least every beatMs so a departure further ahead is reflected too.
    if (
      this.place === undefined ||
      blocker?.id !== this.lastBlocker ||
      holderRow?.id !== this.lastHolder ||
      now - this.lastCount >= beatMs
    ) {
      const ahead =
        this.lane === NORMAL
          ? s.count.get(NORMAL, this.id).n
          : s.count.get(NORMAL, LAST_ID).n + s.count.get(YIELDING, this.id).n
      const total = s.count.get(NORMAL, LAST_ID).n + s.count.get(YIELDING, LAST_ID).n
      this.place = { position: ahead + 1, total }
      this.lastBlocker = blocker?.id
      this.lastHolder = holderRow?.id
      this.lastCount = now
    }
    return { heldAt: undefined, holder, now }
  }

  report({ holder, now }) {
    const { position, total } = this.place
    const notice = `${position}/${total}/${holder?.id ?? (this.first ? 'unnamed' : '')}`
    if (notice === this.lastNotice) {
      return
    }
    this.lastNotice = notice
    const place = `${WAITING} Position ${position} of ${total}.`
    if (holder) {
      this.log(
        `${place} Running now: pid ${holder.pid} in ${holder.cwd}, started ${formatAge(now - holder.held_at)} ago.`
      )
    } else if (this.first) {
      // Queue rows cannot prove who owns the lock, so a holder without a live heartbeat stays unnamed.
      this.log(
        `${place} Running now: a run the queue cannot name, such as one from an older checkout.`
      )
    } else {
      this.log(place)
    }
  }

  /**
   * The waiter at the front of the line clears silent tickets of exited processes and of pids now
   * naming a different process, at most once per staleMs and SWEEP_LIMIT tickets at a time.
   * Unknown start times never count as a mismatch.
   */
  sweepSilent() {
    const now = Date.now()
    if (!this.first || now - this.lastSweep < this.timing.staleMs) {
      return
    }
    this.lastSweep = now
    const s = this.queue.statements
    let rows = attempt(() => s.silent.all(SILENT, this.sweepAfter, SWEEP_LIMIT)) ?? []
    if (rows.length === 0 && this.sweepAfter > 0) {
      this.sweepAfter = 0
      rows = attempt(() => s.silent.all(SILENT, 0, SWEEP_LIMIT)) ?? []
    }
    if (rows.length === 0) {
      return
    }
    this.sweepAfter = rows.at(-1).id
    const live = rows.filter((row) => !processGone(row.pid) && row.started !== null)
    const started = live.length > 0 ? readStartTimes(live.map((row) => row.pid)) : new Map()
    for (const row of rows) {
      const current = started.get(row.pid)
      const reused = row.started !== null && current !== undefined && current !== row.started
      if (processGone(row.pid) || reused) {
        // Removed only if it is still the same silent ticket: a check-in in between keeps it.
        attempt(() => s.removeSilent.run(row.id, SILENT, row.seen_at))
      }
    }
  }
}

function holdSlot(lock, queue, id, timing) {
  // Metadata only: a failing heartbeat must never end or disturb the check holding the slot.
  const timer = setInterval(() => {
    try {
      if (queue.beatHeld(id) === 0) {
        clearInterval(timer)
      }
    } catch {
      clearInterval(timer)
    }
  }, timing.holderBeatMs)
  timer.unref()
  let releasing
  // Resolves once the slot is unlocked; callers may ignore it.
  return () => {
    releasing ??= track(new Promise((resolve) => release(resolve)))
    return releasing
  }

  function release(resolve) {
    clearInterval(timer)
    const unlock = () => {
      if (lock.isOpen) {
        lock.close()
      }
    }
    const startedAt = Date.now()
    const step = () => {
      let done
      try {
        // Drop the ticket and unlock in one queue transaction, so no waiter sees one without the other.
        done = queue.releaseHeld(id, unlock)
      } catch {
        // A broken queue only loses metadata; the slot itself is still released below.
        queue.close()
        done = false
      }
      if (done) {
        resolve()
        return
      }
      if (!queue.closed && Date.now() - startedAt < timing.holderFreshMs) {
        // Keeps the process alive for at most holderFreshMs, so the slot is never left locked.
        setTimeout(step, Math.min(100, timing.holderFreshMs))
        return
      }
      // The queue stayed busy: by now this holder's heartbeat is too old to be named, so unlock.
      unlock()
      queue.removeEventually(id)
      resolve()
    }
    step()
  }
}

class Queue {
  constructor(file) {
    // Short, so a stalled peer costs one poll; busy work is retried on a later poll.
    this.db = new DatabaseSync(file, { timeout: 100 })
    this.statements = undefined
    this.closed = false
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
          this.db.exec(`CREATE TABLE IF NOT EXISTS tickets_v2 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pid INTEGER NOT NULL,
            started TEXT,
            cwd TEXT NOT NULL,
            enqueued_at INTEGER NOT NULL,
            seen_at INTEGER NOT NULL,
            lane INTEGER NOT NULL,
            held_at INTEGER
          );
          CREATE INDEX IF NOT EXISTS tickets_v2_lane ON tickets_v2 (lane, id) WHERE held_at IS NULL;
          CREATE INDEX IF NOT EXISTS tickets_v2_held ON tickets_v2 (id) WHERE held_at IS NOT NULL;`)
        )
        this.statements = prepareStatements(this.db)
        return true
      }) ?? false
    )
  }

  /** Rows changed, or undefined when busy. */
  beatHeld(id) {
    return attempt(() => Number(this.statements.beatHeld.run(Date.now(), id).changes))
  }

  /** Deletes the held ticket and runs `unlock` in one transaction; false when the queue is busy. */
  releaseHeld(id, unlock) {
    const done = attempt(() =>
      transaction(this.db, () => {
        this.statements.removeOwn.run(id, process.pid)
        unlock()
        return true
      })
    )
    if (done) {
      this.close()
    }
    return done === true
  }

  /**
   * Removes this process's ticket, retrying in the background until the queue frees up, then
   * closes. The timer does not keep the process alive; if the process exits, its pid marks the
   * ticket dead.
   */
  removeEventually(id) {
    if (this.closed) {
      return
    }
    this.removal ??= track(
      new Promise((resolve) => {
        const step = () => {
          let done
          try {
            done =
              id === undefined || this.statements === undefined
                ? true
                : attempt(() => this.statements.removeOwn.run(id, process.pid))
          } catch {
            done = true
          }
          if (done !== undefined) {
            this.close()
            resolve()
            return
          }
          setTimeout(step, 250).unref()
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
  const columns = 'id, pid, started, cwd, seen_at, lane, held_at'
  return {
    insert: db.prepare(
      'INSERT INTO tickets_v2 (pid, started, cwd, enqueued_at, seen_at, lane) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    own: db.prepare('SELECT lane FROM tickets_v2 WHERE id = ? AND held_at IS NULL'),
    beat: db.prepare('UPDATE tickets_v2 SET seen_at = ?, lane = ? WHERE id = ?'),
    ahead: db.prepare(
      `SELECT ${columns} FROM tickets_v2 INDEXED BY tickets_v2_lane
       WHERE held_at IS NULL AND lane = ? AND id < ? ORDER BY id DESC LIMIT 1`
    ),
    count: db.prepare(
      `SELECT COUNT(*) AS n FROM tickets_v2 INDEXED BY tickets_v2_lane
       WHERE held_at IS NULL AND lane = ? AND id < ?`
    ),
    silence: db.prepare('UPDATE tickets_v2 SET lane = ? WHERE id = ?'),
    silent: db.prepare(
      `SELECT ${columns} FROM tickets_v2 INDEXED BY tickets_v2_lane
       WHERE held_at IS NULL AND lane = ? AND id > ? ORDER BY id LIMIT ?`
    ),
    removeSilent: db.prepare(
      'DELETE FROM tickets_v2 WHERE id = ? AND held_at IS NULL AND lane = ? AND seen_at = ?'
    ),
    holder: db.prepare(
      `SELECT ${columns} FROM tickets_v2 INDEXED BY tickets_v2_held
       WHERE held_at IS NOT NULL ORDER BY id DESC LIMIT 1`
    ),
    hold: db.prepare('UPDATE tickets_v2 SET held_at = ?, seen_at = ? WHERE id = ?'),
    beatHeld: db.prepare('UPDATE tickets_v2 SET seen_at = ? WHERE id = ? AND held_at IS NOT NULL'),
    removeOtherHeld: db.prepare('DELETE FROM tickets_v2 WHERE held_at IS NOT NULL AND id <> ?'),
    remove: db.prepare('DELETE FROM tickets_v2 WHERE id = ?'),
    removeOwn: db.prepare('DELETE FROM tickets_v2 WHERE id = ? AND pid = ?')
  }
}

function isBusy(error) {
  // SQLITE_BUSY (5) and SQLITE_LOCKED (6), including their extended codes.
  const code = error?.errcode & 0xff
  return code === 5 || code === 6
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
    if ((error.errcode & 0xff) !== 5) {
      throw error
    }
    return false
  }
}

/** Gives the slot back after a claim whose queue transaction did not commit. */
function endSlotTransaction(lock) {
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

function readLinuxStat(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  // The command name can hold spaces and parentheses; fields resume after the last ')'.
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ')
  return { ppid: Number(fields[1]), started: fields[19] }
}

/** ps rows as [pid, ppid or undefined, lstart]; lstart starts with a weekday, never a digit. */
function readPs(args) {
  const result = spawnSync('ps', args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
    timeout: 5000
  })
  const rows = []
  for (const line of result.stdout?.split('\n') ?? []) {
    const match = /^\s*(\d+)\s+(?:(\d+)\s+)?(\S.*\S)\s*$/.exec(line)
    if (match) {
      rows.push([Number(match[1]), match[2] === undefined ? undefined : Number(match[2]), match[3]])
    }
  }
  return rows
}

/** Process start times as opaque strings; a pid whose start time changed now names another process. */
export function readStartTimes(pids) {
  const started = new Map()
  if (pids.length === 0) {
    return started
  }
  if (process.platform === 'linux') {
    for (const pid of pids) {
      try {
        started.set(pid, readLinuxStat(pid).started)
      } catch {
        // Gone or unreadable: unknown.
      }
    }
    return started
  }
  for (const [pid, , lstart] of readPs(['-o', 'pid=,lstart=', '-p', pids.join(',')])) {
    started.set(pid, lstart)
  }
  return started
}

/**
 * This process's start time and its launchers: the processes above it when it queues, up to
 * MAX_ANCESTORS levels, stopping at init or at the first link that cannot be read. At most one
 * ps call per acquisition, none on Linux.
 */
function describeSelf(ancestors) {
  const self = { pid: process.pid, started: null, cwd: currentDirectory(), ancestors }
  if (ancestors !== undefined) {
    ownStart ??= readStartTimes([process.pid]).get(process.pid) ?? null
    self.started = ownStart
    return self
  }
  let parentOf
  if (process.platform === 'linux') {
    ownStart ??= readStartTimes([process.pid]).get(process.pid) ?? null
    parentOf = (pid) => {
      try {
        return readLinuxStat(pid).ppid
      } catch {
        return 0
      }
    }
  } else {
    const parents = new Map()
    for (const [pid, ppid, lstart] of readPs(['-A', '-o', 'pid=,ppid=,lstart='])) {
      parents.set(pid, ppid)
      if (pid === process.pid) {
        ownStart ??= lstart
      }
    }
    ownStart ??= null
    parentOf = (pid) => parents.get(pid) ?? 0
  }
  self.started = ownStart
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
