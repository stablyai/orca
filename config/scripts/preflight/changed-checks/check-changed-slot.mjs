import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const slotDirectory = path.join(homedir(), '.cache', 'orca', 'preflight')
const slotFile = path.join(slotDirectory, `${hostname()}.sqlite`)
const WAITING = 'Waiting for another local check:changed run to finish…'
// The place in line is recounted when the run ahead changes, and at least this often.
const POSITION_REFRESH_MS = 60_000
const LAST_ID = Number.MAX_SAFE_INTEGER
let ownStart

// The slot holder keeps a write transaction open on the slot file for its whole run, so waiters
// cannot write their tickets there. The queue lives in a sibling file with short transactions.
export function queueFileFor(file) {
  return `${file.replace(/\.sqlite$/, '')}.queue.sqlite`
}

/**
 * Admits one check:changed run per host, in arrival order.
 *
 * Exclusion comes only from the SQLite write lock on `file`, which the OS drops when its holder
 * dies. The ticket queue only decides which waiter may try for that lock, so a stale or wrong
 * ticket can delay a run but never admit two at once.
 *
 * Order: waiters that keep polling go by arrival; a waiter whose launcher (any process above it
 * when it queued, except init) has exited goes behind them; a waiter silent for `staleMs` goes
 * behind everyone until it polls again. Each waiter decides from its own snapshot of the queue, so
 * a silent waiter that resumes after another waiter took the slot waits for that run.
 */
export async function acquireChangedCheckSlot(file = slotFile, options = {}) {
  const pollMs = options.pollMs ?? 1000
  const staleMs = options.staleMs ?? 30_000
  const beatMs = staleMs / 3
  const log = options.log ?? console.log
  const signal = options.signal
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const lock = new DatabaseSync(file)
  const queue = new Queue(queueFileFor(file))
  let id
  try {
    const self = describeSelf(options.ancestors)
    let yielding = false
    let lastAncestorCheck = 0
    let lastBeat = 0
    let lastStartCheck = 0
    let lastCount = 0
    let lastBlocker
    let place = { position: 0, total: 0 }
    let lastNotice = ''
    for (;;) {
      signal?.throwIfAborted()
      const now = Date.now()
      if (!yielding && now - lastAncestorCheck >= beatMs) {
        lastAncestorCheck = now
        if (self.ancestors.some((pid) => !pidExists(pid))) {
          yielding = true
          lastBeat = 0
          log(
            'The process that started this check has exited; runs whose launcher is still running go first.'
          )
        }
      }
      // Busy queue operations return undefined and are retried on the next poll.
      if (id === undefined || queue.has(id) === false) {
        // Enqueued before the first await when uncontended, so arrival order is call order.
        id = queue.enqueue(self, yielding, now)
        lastBeat = now
      } else if (now - lastBeat >= beatMs && queue.beat(id, yielding, now) !== undefined) {
        lastBeat = now
      }
      const scan = id === undefined ? undefined : queue.findBlocker(id, yielding, now - staleMs)
      if (scan) {
        queue.remove(scan.dead)
        // Spawning ps is the only costly check: only for silent tickets met in the scan, at most once per staleMs.
        if (scan.silent.length > 0 && now - lastStartCheck >= staleMs) {
          lastStartCheck = now
          const started = readStartTimes(scan.silent.map((row) => row.pid))
          queue.remove(
            scan.silent
              .filter((row) => {
                const current = started.get(row.pid)
                return current !== undefined && current !== row.started
              })
              .map((row) => row.id)
          )
        }
        const first = scan.blocker === undefined
        if (first && tryLock(lock)) {
          return holdSlot({ lock, queue, id, self, beatMs })
        }
        if (scan.blocker?.id !== lastBlocker || now - lastCount >= POSITION_REFRESH_MS) {
          place = queue.place(id, yielding, now - staleMs) ?? place
          lastBlocker = scan.blocker?.id
          lastCount = now
        }
        const holder = queue.holder(now - staleMs)
        const notice = `${place.position}/${place.total}/${holder?.id ?? (first ? 'unknown' : '')}`
        if (notice !== lastNotice) {
          lastNotice = notice
          log(describeWait(place, holder, first, now))
        }
      }
      await delay(pollMs, undefined, { signal })
    }
  } catch (error) {
    lock.close()
    queue.close(id)
    throw error
  }
}

function holdSlot({ lock, queue, id, self, beatMs }) {
  const heldAt = Date.now()
  let published = queue.hold(id, self, heldAt) !== undefined
  // The holder heartbeats so waiters name it only while it is provably still running.
  const timer = setInterval(() => {
    published = (published ? queue.beatHeld(id, self) : queue.hold(id, self, heldAt)) !== undefined
  }, beatMs)
  timer.unref()
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    clearInterval(timer)
    // Unlock first, so a waiter never sees the slot free while its last holder is still listed.
    try {
      lock.close()
    } finally {
      queue.close(id)
    }
  }
}

class Queue {
  constructor(file) {
    // Short, so a stalled peer costs one poll; busy work is retried on the next poll.
    this.db = new DatabaseSync(file, { timeout: 100 })
    this.statements = undefined
  }

  setup() {
    if (this.statements) {
      return true
    }
    return (
      attempt(() => {
        // Tickets need no durability across a power loss, so WAL with NORMAL sync keeps heartbeat
        // commits off fsync while staying safe from corruption, and readers never wait on writers.
        this.db.exec('PRAGMA journal_mode = WAL')
        this.db.exec('PRAGMA synchronous = NORMAL')
        transaction(this.db, () =>
          this.db.exec(`CREATE TABLE IF NOT EXISTS tickets_v1 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pid INTEGER NOT NULL,
            started TEXT,
            cwd TEXT NOT NULL,
            enqueued_at INTEGER NOT NULL,
            seen_at INTEGER NOT NULL,
            held_at INTEGER,
            yielding INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS tickets_v1_waiting ON tickets_v1 (yielding, id)
            WHERE held_at IS NULL;
          CREATE INDEX IF NOT EXISTS tickets_v1_held ON tickets_v1 (id)
            WHERE held_at IS NOT NULL;`)
        )
        this.statements = prepareStatements(this.db)
        return true
      }) ?? false
    )
  }

  enqueue(self, yielding, now) {
    if (!this.setup()) {
      return undefined
    }
    return attempt(() =>
      Number(
        this.statements.insert.run(
          self.pid,
          self.started,
          self.cwd,
          now,
          now,
          yielding ? 1 : 0,
          null
        ).lastInsertRowid
      )
    )
  }

  /** false only when the ticket is known to be gone; undefined when the queue is busy. */
  has(id) {
    return attempt(() => this.statements.own.get(id) !== undefined)
  }

  beat(id, yielding, now) {
    return attempt(() => this.statements.beat.run(now, yielding ? 1 : 0, id))
  }

  /**
   * Walks back from this ticket through the tickets ranked ahead of it, stopping at the nearest
   * one still polling, so a healthy queue costs one indexed row. Dead tickets are collected for
   * removal and silent ones are passed over. Undefined when the queue is busy.
   */
  findBlocker(id, yielding, freshSince) {
    const scan = { blocker: undefined, dead: [], silent: [] }
    // A normal ticket waits for normal tickets ahead of it; a yielding one waits for every
    // normal ticket and for yielding tickets ahead of it.
    const lanes = yielding
      ? [
          [0, LAST_ID],
          [1, id]
        ]
      : [[0, id]]
    const finished = attempt(() => {
      for (const [lane, before] of lanes) {
        for (let row = this.statements.previous.get(lane, before); row;) {
          if (row.id !== id) {
            if (!pidExists(row.pid)) {
              scan.dead.push(row.id)
            } else if (row.seen_at < freshSince) {
              scan.silent.push(row)
            } else {
              scan.blocker = row
              return true
            }
          }
          row = this.statements.previous.get(lane, row.id)
        }
      }
      return true
    })
    return finished ? scan : undefined
  }

  /** Recounts the line; a full scan, so callers only run it when the run ahead changes or once a minute. */
  place(id, yielding, freshSince) {
    return attempt(() => {
      const lane = yielding ? 1 : 0
      const { total, ahead } = this.statements.place.get(lane, lane, id, freshSince, id)
      return { position: ahead + 1, total: total + 1 }
    })
  }

  /** The latest held ticket, only while its process is alive and still heartbeating. */
  holder(freshSince) {
    const row = attempt(() => this.statements.holder.get())
    return row && row.seen_at >= freshSince && pidExists(row.pid) ? row : undefined
  }

  hold(id, self, heldAt) {
    // Only one connection can hold the slot lock, so any other held ticket is left from a crash.
    return attempt(() =>
      transaction(this.db, () => {
        const { hold, insert, removeOtherHeld } = this.statements
        const now = Date.now()
        if (hold.run(heldAt, now, id).changes === 0) {
          insert.run(self.pid, self.started, self.cwd, heldAt, now, 0, heldAt)
        }
        removeOtherHeld.run(id)
        return true
      })
    )
  }

  beatHeld(id, self) {
    return attempt(() => {
      const now = Date.now()
      if (this.statements.beatHeld.run(now, id).changes === 0) {
        this.statements.insert.run(self.pid, self.started, self.cwd, now, now, 0, now)
      }
      return true
    })
  }

  remove(ids) {
    for (const id of ids) {
      attempt(() => this.statements.remove.run(id))
    }
  }

  /** Drops this ticket and closes; a busy queue is retried in the background without holding the process open. */
  close(id, attempts = 20) {
    const done =
      id === undefined || this.statements === undefined
        ? true
        : attempt(() => this.statements.removeOwn.run(id, process.pid))
    if (done !== undefined || attempts <= 0) {
      this.db.close()
      return
    }
    setTimeout(() => this.close(id, attempts - 1), 250).unref()
  }
}

function prepareStatements(db) {
  const columns = 'id, pid, started, cwd, enqueued_at, seen_at, held_at, yielding'
  return {
    insert: db.prepare(
      'INSERT INTO tickets_v1 (pid, started, cwd, enqueued_at, seen_at, yielding, held_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ),
    own: db.prepare('SELECT id FROM tickets_v1 WHERE id = ?'),
    beat: db.prepare(
      'UPDATE tickets_v1 SET seen_at = ?, yielding = ? WHERE id = ? AND held_at IS NULL'
    ),
    previous: db.prepare(
      `SELECT ${columns} FROM tickets_v1 INDEXED BY tickets_v1_waiting
       WHERE held_at IS NULL AND yielding = ? AND id < ? ORDER BY id DESC LIMIT 1`
    ),
    place: db.prepare(
      `SELECT COUNT(*) AS total,
         COALESCE(SUM(yielding < ? OR (yielding = ? AND id < ?)), 0) AS ahead
       FROM tickets_v1 WHERE held_at IS NULL AND seen_at >= ? AND id <> ?`
    ),
    holder: db.prepare(
      `SELECT ${columns} FROM tickets_v1 INDEXED BY tickets_v1_held
       WHERE held_at IS NOT NULL ORDER BY id DESC LIMIT 1`
    ),
    hold: db.prepare('UPDATE tickets_v1 SET held_at = ?, seen_at = ? WHERE id = ?'),
    beatHeld: db.prepare('UPDATE tickets_v1 SET seen_at = ? WHERE id = ? AND held_at IS NOT NULL'),
    removeOtherHeld: db.prepare('DELETE FROM tickets_v1 WHERE held_at IS NOT NULL AND id <> ?'),
    remove: db.prepare('DELETE FROM tickets_v1 WHERE id = ?'),
    removeOwn: db.prepare('DELETE FROM tickets_v1 WHERE id = ? AND pid = ?')
  }
}

/** Runs `body`, returning undefined instead of throwing when SQLite reports the database busy or locked. */
function attempt(body) {
  try {
    return body()
  } catch (error) {
    // SQLITE_BUSY (5) and SQLITE_LOCKED (6), including their extended codes.
    const code = error.errcode & 0xff
    if (code === 5 || code === 6) {
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
    if (error.errcode !== 5) {
      throw error
    }
    return false
  }
}

function describeWait({ position, total }, holder, first, now) {
  const place = position > 0 ? ` Position ${position} of ${total}.` : ''
  if (holder) {
    return `${WAITING}${place} Running now: pid ${holder.pid} in ${holder.cwd}, started ${formatAge(now - holder.held_at)} ago.`
  }
  // Queue rows cannot prove who owns the lock, so a holder without a live ticket stays unnamed.
  return first
    ? `${WAITING}${place} Running now: a run that is not in the queue, such as one from an older checkout.`
    : `${WAITING}${place}`
}

export function formatAge(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
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
        // Gone, or unreadable; pidExists decides.
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
 * This process's start time, and its launchers: every process above it now, except init. If one
 * exits later, whatever started this run is gone. At most one ps call per acquisition, none on Linux.
 */
function describeSelf(ancestors) {
  const self = { pid: process.pid, started: ownStart ?? null, cwd: currentDirectory(), ancestors }
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
  if (self.ancestors === undefined) {
    self.ancestors = []
    for (let pid = process.ppid; pid > 1 && self.ancestors.length < 16; pid = parentOf(pid)) {
      if (self.ancestors.includes(pid)) {
        break
      }
      self.ancestors.push(pid)
    }
  }
  return self
}
