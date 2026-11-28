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

type ProcessIdentity = { pgid: number; identity: string }
type Identities = ReadonlyMap<number, ProcessIdentity>

// Only stop and exit change who holds the pane; run/sleep churn must not void an anchor.
function lifecycleState(state: string): string {
  return state === 'T' || state === 't' ? 'T' : state === 'Z' || state === 'X' ? 'Z' : ''
}

// The addon dedups named pids pairwise; past this a kinfo-only whole-table read (the old per-round cost) is cheaper.
const MAX_NAMED_PIDS = 256

type DarwinBatch = { pids: Set<number>; identities: Promise<Identities | null> }
let pendingDarwinBatch: DarwinBatch | null = null

/** Polls arriving in one socket read share one native read, so N panes never queue N reads behind the reader's cap. */
function readDarwinIdentities(pids: readonly number[]): Promise<Identities | null> {
  let batch = pendingDarwinBatch
  if (!batch) {
    const created: DarwinBatch = { pids: new Set(), identities: Promise.resolve(null) }
    created.identities = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
      pendingDarwinBatch = null
      return readDarwinRows(created.pids)
    })
    pendingDarwinBatch = created
    batch = created
  }
  for (const pid of pids) {
    batch.pids.add(pid)
  }
  return batch.identities
}

async function readDarwinRows(pids: ReadonlySet<number>): Promise<Identities | null> {
  const addon = loadLibprocAddon()
  if (!addon || !isNativeReaderHealthy()) {
    return null
  }
  const rows = await readFreshNativeTable(
    addon,
    pids.size > MAX_NAMED_PIDS
      ? { command: false }
      : { command: false, pids: [...pids].sort((a, b) => a - b) },
    registerNativeRequest(),
    monotonicNow() + PROCESS_TABLE_EVIDENCE_BUDGET_MS
  )
  if (!Array.isArray(rows)) {
    return null
  }
  const identities = new Map<number, ProcessIdentity>()
  for (const row of rows) {
    if (pids.has(row.pid)) {
      const state = row.status === SSTOP ? 'T' : row.status === SZOMB ? 'Z' : ''
      identities.set(row.pid, {
        pgid: row.pgid,
        identity: `${row.pid}@${row.startSec}.${row.startUsec ?? ''}:${state}:${row.comm}`
      })
    }
  }
  return identities
}

async function readLinuxIdentity(pid: number): Promise<[number, ProcessIdentity] | null> {
  let stat: string
  try {
    // stat alone: its comm changes on exec like macOS's p_comm, and argv (which can hold a launch prompt) is never read.
    stat = await readFile(`/proc/${pid}/stat`, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  const fields = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)
  const pgid = Number(fields[2])
  const start = fields[19]
  if (!Number.isSafeInteger(pgid) || !start) {
    throw new Error(`unparsable /proc/${pid}/stat`)
  }
  const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))
  return [pid, { pgid, identity: `${pid}@${start}:${lifecycleState(fields[0] ?? '')}:${comm}` }]
}

/** Identities of the given pids that are live members of `group`, from per-pid reads only (no table scan, no child
 * process); an exited or regrouped pid is absent. Null when the read itself failed. */
export async function readForegroundGroupMembers(
  pids: readonly number[],
  group: number
): Promise<ReadonlyMap<number, string> | null> {
  let identities: Identities
  try {
    if (process.platform === 'darwin') {
      const read = await readDarwinIdentities(pids)
      if (!read) {
        return null
      }
      identities = read
    } else if (process.platform === 'linux') {
      const entries = await Promise.all(pids.map(readLinuxIdentity))
      identities = new Map(entries.filter((entry) => entry !== null))
    } else {
      return null
    }
  } catch {
    return null
  }
  const members = new Map<number, string>()
  for (const pid of pids) {
    const entry = identities.get(pid)
    if (entry && entry.pgid === group) {
      members.set(pid, entry.identity)
    }
  }
  return members
}
