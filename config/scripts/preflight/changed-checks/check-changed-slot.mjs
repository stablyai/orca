import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const slotDirectory = path.join(homedir(), '.cache', 'orca', 'preflight')
const slotFile = path.join(slotDirectory, `${hostname()}.sqlite`)
const WAITING = 'Waiting for another local check:changed run to finish…'
const SQLITE_BUSY = 5
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
 * ticket can delay a run but can never admit two at once.
 */
export async function acquireChangedCheckSlot(file = slotFile, options = {}) {
  const pollMs = options.pollMs ?? 1000
  // A waiter that has not polled for this long (stopped, or its pid now belongs to another
  // process) goes behind waiters that are still polling; it keeps its ticket while its pid lives.
  const staleMs = options.staleMs ?? 30_000
  const log = options.log ?? console.log
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const lock = new DatabaseSync(file)
  let queue
  try {
    queue = new DatabaseSync(queueFileFor(file), { timeout: 10_000 })
    // Enqueue before the first await so arrival order is call order.
    const tickets = openTickets(queue)
    ownStart ??= readStartTimes([process.pid]).get(process.pid) ?? null
    const self = { pid: process.pid, started: ownStart, cwd: currentDirectory() }
    const ancestors = options.ancestors ?? readAncestors()
    let id = tickets.enqueue(self, Date.now())
    let orphaned = false
    let lastNotice = ''
    let lastStartCheck = 0
    for (;;) {
      if (!orphaned && ancestors.some((pid) => !pidExists(pid))) {
        orphaned = true
        log(
          'The process that started this check has exited; runs whose launcher is still running go first.'
        )
      }
      const now = Date.now()
      let rows
      ;({ id, rows } = tickets.heartbeat(id, self, orphaned, now))

      const dead = []
      const suspects = []
      for (const row of rows) {
        if (row.id === id) {
          continue
        }
        if (!pidExists(row.pid)) {
          dead.push(row.id)
        } else if (row.held_at === null && row.started !== null && row.seen_at < now - staleMs) {
          suspects.push(row)
        }
      }
      // Spawning ps is the only costly check, so it runs only for silent waiters, at most once per staleMs.
      if (suspects.length > 0 && now - lastStartCheck >= staleMs) {
        lastStartCheck = now
        const started = readStartTimes(suspects.map((row) => row.pid))
        for (const row of suspects) {
          const current = started.get(row.pid)
          if (current !== undefined && current !== row.started) {
            dead.push(row.id)
          }
        }
      }
      if (dead.length > 0) {
        tickets.remove(dead)
      }

      const live = rows.filter((row) => !dead.includes(row.id))
      const yields = (row) => (row.yielding || row.seen_at < now - staleMs ? 1 : 0)
      const waiting = live
        .filter((row) => row.held_at === null)
        .sort((a, b) => yields(a) - yields(b) || a.id - b.id)
      const first = waiting[0]?.id === id
      if (first && tryLock(lock)) {
        tickets.hold(id, Date.now())
        return releaser(lock, queue, tickets, id)
      }

      const position = waiting.findIndex((row) => row.id === id) + 1
      const holder = live.findLast((row) => row.held_at !== null)
      const notice = `${position}/${waiting.length}/${holder?.id ?? (first ? 'outside' : '')}`
      if (notice !== lastNotice) {
        lastNotice = notice
        log(describeWait(position, waiting.length, holder, first, now))
      }
      await delay(pollMs)
    }
  } catch (error) {
    queue?.close()
    lock.close()
    throw error
  }
}

function openTickets(queue) {
  // Every waiter writes a heartbeat each poll. Tickets need no durability across a power loss, so
  // WAL with NORMAL sync keeps those commits off fsync while staying safe from corruption.
  queue.exec('PRAGMA journal_mode = WAL')
  queue.exec('PRAGMA synchronous = NORMAL')
  transaction(queue, () =>
    queue.exec(`CREATE TABLE IF NOT EXISTS tickets_v1 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pid INTEGER NOT NULL,
      started TEXT,
      cwd TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      seen_at INTEGER NOT NULL,
      held_at INTEGER,
      yielding INTEGER NOT NULL DEFAULT 0
    )`)
  )
  const insert = queue.prepare(
    'INSERT INTO tickets_v1 (pid, started, cwd, enqueued_at, seen_at, yielding) VALUES (?, ?, ?, ?, ?, ?)'
  )
  const touch = queue.prepare(
    'UPDATE tickets_v1 SET seen_at = ?, yielding = ? WHERE id = ? AND held_at IS NULL'
  )
  const selectAll = queue.prepare(
    'SELECT id, pid, started, cwd, enqueued_at, seen_at, held_at, yielding FROM tickets_v1 ORDER BY id'
  )
  const remove = queue.prepare('DELETE FROM tickets_v1 WHERE id = ?')
  const hold = queue.prepare('UPDATE tickets_v1 SET held_at = ? WHERE id = ?')
  // Only one connection can hold the slot lock, so any other held ticket is left from a crash.
  const removeOtherHeld = queue.prepare(
    'DELETE FROM tickets_v1 WHERE held_at IS NOT NULL AND id <> ?'
  )
  const enqueue = (self, now, yielding = false) =>
    Number(insert.run(self.pid, self.started, self.cwd, now, now, yielding ? 1 : 0).lastInsertRowid)
  return {
    enqueue: (self, now) => transaction(queue, () => enqueue(self, now)),
    heartbeat: (id, self, yielding, now) =>
      transaction(queue, () => {
        // A ticket another waiter dropped rejoins at the back of the queue.
        const ticket =
          touch.run(now, yielding ? 1 : 0, id).changes === 0 ? enqueue(self, now, yielding) : id
        return { id: ticket, rows: selectAll.all() }
      }),
    remove: (ids) => transaction(queue, () => ids.forEach((id) => remove.run(id))),
    hold: (id, now) =>
      transaction(queue, () => {
        hold.run(now, id)
        removeOtherHeld.run(id)
      }),
    release: (id) => remove.run(id)
  }
}

function releaser(lock, queue, tickets, id) {
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    // Unlock first, so the next waiter never sees an unheld slot that is still locked.
    try {
      lock.close()
    } finally {
      try {
        tickets.release(id)
      } catch {
        // A leftover held ticket only labels the wait message; the next holder deletes it.
      } finally {
        queue.close()
      }
    }
  }
}

function transaction(db, body) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = body()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function tryLock(lock) {
  try {
    // SQLite releases the write lock even when a check is killed.
    lock.exec('BEGIN IMMEDIATE')
    return true
  } catch (error) {
    if (error.errcode !== SQLITE_BUSY) {
      throw error
    }
    return false
  }
}

function describeWait(position, total, holder, first, now) {
  const place = position > 0 ? ` Position ${position} of ${total}.` : ''
  if (holder) {
    return `${WAITING}${place} Running now: pid ${holder.pid} in ${holder.cwd}, started ${formatAge(now - holder.held_at)} ago.`
  }
  return first
    ? `${WAITING}${place} Running now: a run from a checkout without the queue.`
    : `${WAITING}${place}`
}

export function formatAge(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) {
    return `${Math.floor(Math.max(0, ms) / 1000)}s`
  }
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

/** Process start times as opaque strings; a pid whose start time changed now names another process. */
export function readStartTimes(pids) {
  const started = new Map()
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
  const result = spawnSync('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' },
    timeout: 5000
  })
  for (const line of result.stdout?.split('\n') ?? []) {
    const match = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(line)
    if (match) {
      started.set(Number(match[1]), match[2])
    }
  }
  return started
}

// Every launcher above this process except init: when one exits, nobody is waiting on this run's result.
function readAncestors() {
  const ancestors = []
  let parentOf
  if (process.platform === 'linux') {
    parentOf = (pid) => {
      try {
        return readLinuxStat(pid).ppid
      } catch {
        return 0
      }
    }
  } else {
    const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 })
    const parents = new Map()
    for (const line of result.stdout?.split('\n') ?? []) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      if (pid) {
        parents.set(pid, ppid)
      }
    }
    parentOf = (pid) => parents.get(pid) ?? 0
  }
  for (let pid = process.ppid; pid > 1 && ancestors.length < 16; pid = parentOf(pid)) {
    if (ancestors.includes(pid)) {
      break
    }
    ancestors.push(pid)
  }
  return ancestors
}
