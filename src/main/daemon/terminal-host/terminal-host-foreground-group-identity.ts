import { readFile } from 'node:fs/promises'
import { monotonicNow } from '../../../shared/concurrency/deadline-settle-notifier'
import { loadLibprocAddon } from '../../../shared/process-observation/darwin/libproc-addon'
import {
  isNativeReaderHealthy,
  readFreshNativeTable,
  registerNativeRequest
} from '../../../shared/process-observation/darwin/libproc-native-reads'
import { SSTOP, SZOMB } from '../../../shared/process-observation/darwin/libproc-ps-format'
import { PROCESS_TABLE_EVIDENCE_BUDGET_MS } from '../../../shared/process-observation/tables/process-table-snapshot-reader'

type ProcessIdentity = { pid: number; pgid: number; start: string; state: string; name: string }

// Only stop and exit change who holds the pane; run/sleep churn must not void an anchor.
function lifecycleState(state: string): string {
  return state === 'T' || state === 't' ? 'T' : state === 'Z' || state === 'X' ? 'Z' : ''
}

type DarwinBatch = { pids: Set<number>; identities: Promise<ProcessIdentity[] | null> }
let pendingDarwinBatch: DarwinBatch | null = null

/** Polls arriving in one socket read share one native read, so N panes never queue N reads behind the reader's cap. */
function readDarwinIdentities(pids: readonly number[]): Promise<ProcessIdentity[] | null> {
  let batch = pendingDarwinBatch
  if (!batch) {
    const created: DarwinBatch = { pids: new Set(), identities: Promise.resolve(null) }
    created.identities = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      pendingDarwinBatch = null
      return readDarwinRows([...created.pids].sort((a, b) => a - b))
    })
    pendingDarwinBatch = created
    batch = created
  }
  for (const pid of pids) {
    batch.pids.add(pid)
  }
  return batch.identities
}

async function readDarwinRows(pids: readonly number[]): Promise<ProcessIdentity[] | null> {
  const addon = loadLibprocAddon()
  if (!addon || !isNativeReaderHealthy()) {
    return null
  }
  const rows = await readFreshNativeTable(
    addon,
    { command: false, pids },
    registerNativeRequest(),
    monotonicNow() + PROCESS_TABLE_EVIDENCE_BUDGET_MS
  )
  if (!Array.isArray(rows)) {
    return null
  }
  return rows.map((row) => ({
    pid: row.pid,
    pgid: row.pgid,
    start: `${row.startSec}.${row.startUsec ?? ''}`,
    state: row.status === SSTOP ? 'T' : row.status === SZOMB ? 'Z' : '',
    name: row.comm
  }))
}

async function readLinuxIdentity(pid: number): Promise<ProcessIdentity | null> {
  const [stat, cmdline] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile(`/proc/${pid}/cmdline`, 'utf8')
  ])
  const fields = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)
  const pgid = Number(fields[2])
  const start = fields[19]
  if (!Number.isSafeInteger(pgid) || !start) {
    return null
  }
  return { pid, pgid, start, state: lifecycleState(fields[0] ?? ''), name: cmdline }
}

/** Identity of the given foreground-group members from per-pid reads only (no table scan, no child process);
 * null when any is missing, outside `group`, or unreadable. */
export async function readForegroundGroupIdentity(
  pids: readonly number[],
  group: number
): Promise<string | null> {
  let identities: (ProcessIdentity | null)[] | null
  try {
    if (process.platform === 'darwin') {
      identities = await readDarwinIdentities(pids)
    } else if (process.platform === 'linux') {
      identities = await Promise.all(pids.map(readLinuxIdentity))
    } else {
      return null
    }
  } catch {
    return null
  }
  if (!identities) {
    return null
  }
  const parts: string[] = []
  for (const pid of pids) {
    const identity = identities.find((entry) => entry?.pid === pid)
    if (!identity || identity.pgid !== group) {
      return null
    }
    parts.push(`${pid}@${identity.start}:${identity.state}:${identity.name}`)
  }
  return parts.join('|')
}
