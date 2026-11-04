// Await daemon exit before deleting temp profiles; late file writes otherwise race recursive cleanup.
// Record PIDs before idle retirement removes their records. Windows descendants can retain profile cwd;
// reject reused-parent PID links by creation time, then await the remaining tree too.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildProcessTableIndex,
  collectDescendantsFromIndex,
  type ProcessTableIndexOf
} from '../../shared/process-table-index'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { parseLinuxStartTicks } from '../agent-hooks/managed-hook-owner-identity'
import { DaemonEndpointOwnershipError } from '../daemon/daemon-endpoint-adoption'
import { parseLinuxProcessState } from '../daemon/daemon-incarnation-evidence'
import { readDaemonPidRecord } from '../daemon/daemon-endpoint-incarnation'
import { readLinuxStat } from '../daemon/daemon-process-inspection'
import { cleanupDaemonForProtocol } from '../daemon/daemon-protocol-cleanup'
import type { WindowsProcessIdentityRow } from '../windows/windows-process-table'
import type { spawnProcess } from '@orca/process-host'

const EXIT_WAIT_MS = 10_000
const POLL_MS = 50
const REMOVE_ATTEMPTS = 8
const REMOVE_RETRY_MS = 150

type ProcessExitDependencies = {
  platform?: NodeJS.Platform
  signalProcess?: (pid: number) => void
  readStat?: typeof readLinuxStat
}

const sleep = (ms: number): Promise<void> => new Promise((settle) => setTimeout(settle, ms))

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}

async function hasExited(pid: number, dependencies: ProcessExitDependencies): Promise<boolean> {
  const signalProcess = dependencies.signalProcess ?? ((pid) => process.kill(pid, 0))
  try {
    signalProcess(pid)
  } catch (error) {
    // EPERM still proves the process exists.
    return errorCode(error) === 'ESRCH'
  }
  if ((dependencies.platform ?? process.platform) !== 'linux') {
    return false
  }
  const stat = await (dependencies.readStat ?? readLinuxStat)(pid)
  // An unreaped zombie has exited even though kill(pid, 0) still succeeds.
  return (
    stat.status === 'present' &&
    stat.value.startsWith(`${pid} (`) &&
    /^\d+$/.test(parseLinuxStartTicks(stat.value) ?? '') &&
    parseLinuxProcessState(stat.value) === 'Z'
  )
}

export async function waitForProcessExit(
  pids: Iterable<number>,
  dependencies: ProcessExitDependencies = {}
): Promise<void> {
  let remaining = [...pids]
  const deadline = Date.now() + EXIT_WAIT_MS
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>((settle) => {
    deadlineTimer = setTimeout(() => settle(null), EXIT_WAIT_MS)
  })
  try {
    while (remaining.length > 0) {
      const exited = await Promise.race([
        Promise.all(remaining.map((pid) => hasExited(pid, dependencies))),
        timedOut
      ])
      if (exited === null) {
        break
      }
      remaining = remaining.filter((_pid, index) => !exited[index])
      if (remaining.length === 0 || Date.now() >= deadline) {
        break
      }
      await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())))
    }
  } finally {
    clearTimeout(deadlineTimer)
  }
  if (remaining.length > 0) {
    throw new Error(`Processes did not exit: ${remaining.join(', ')}`)
  }
}

export async function killAndAwaitExit(pids: Iterable<number>): Promise<void> {
  const pending = [...pids]
  for (const pid of pending) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  await waitForProcessExit(pending)
}

export async function killChildAndWait(child: ReturnType<typeof spawnProcess>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  const exited = new Promise((settle) => child.once('exit', settle))
  child.kill('SIGKILL')
  await exited
}

type ProfileDaemonRecord = {
  /** First observed creation time for each daemon PID. */
  pids: Map<number, number | undefined>
  descendants: Map<string, WindowsProcessIdentityRow>
}

const recordedProfiles = new Map<string, ProfileDaemonRecord>()

async function readWindowsProcessTable(): Promise<WindowsProcessIdentityRow[] | null> {
  if (process.platform !== 'win32') {
    return null
  }
  try {
    const table = await import('../windows/windows-process-table')
    return table.isWindowsProcessTableAvailable()
      ? await table.readWindowsProcessIdentityTableFresh()
      : null
  } catch {
    return null
  }
}

let readProcessTable = readWindowsProcessTable

export function __setDaemonProcessTableReaderForTests(
  reader?: () => Promise<WindowsProcessIdentityRow[] | null>
): void {
  readProcessTable = reader ?? readWindowsProcessTable
}

const identityKey = (row: WindowsProcessIdentityRow): string =>
  `${row.pid}:${row.creationTimeMs ?? ''}`

function collectDaemonDescendants(
  index: ProcessTableIndexOf<WindowsProcessIdentityRow>,
  daemonPid: number,
  daemonCreationTimeMs: number | undefined
): WindowsProcessIdentityRow[] {
  const holderCreated = index.byPid.get(daemonPid)?.creationTimeMs
  // A new PID holder postdates the old daemon’s children; exclude its own descendants.
  const reusedAt =
    daemonCreationTimeMs !== undefined && holderCreated !== daemonCreationTimeMs
      ? holderCreated
      : undefined
  return collectDescendantsFromIndex(index, daemonPid, (row) => {
    const created = row.creationTimeMs
    if (created === undefined) {
      // Unknown ages stay included so real leaks still fail teardown.
      return false
    }
    if (row.ppid !== daemonPid) {
      const parentCreated = index.byPid.get(row.ppid)?.creationTimeMs
      return parentCreated !== undefined && created < parentCreated
    }
    return (
      (daemonCreationTimeMs !== undefined && created < daemonCreationTimeMs) ||
      (reusedAt !== undefined && created >= reusedAt)
    )
  })
}

function readProfileDaemons(daemonDir: string): { pid: number; protocolVersion: number }[] {
  return (existsSync(daemonDir) ? readdirSync(daemonDir) : []).flatMap((name) => {
    const match = /^daemon-v(\d+)\.pid$/u.exec(name)
    const pid = match ? readDaemonPidRecord(join(daemonDir, name))?.pid : undefined
    return pid && match ? [{ pid, protocolVersion: Number(match[1]) }] : []
  })
}

async function recordDaemonTree(daemonDir: string): Promise<ProfileDaemonRecord> {
  const record = recordedProfiles.get(daemonDir) ?? { pids: new Map(), descendants: new Map() }
  recordedProfiles.set(daemonDir, record)
  for (const { pid } of readProfileDaemons(daemonDir)) {
    if (!record.pids.has(pid)) {
      record.pids.set(pid, undefined)
    }
  }
  const rows = await readProcessTable()
  if (rows) {
    const index = buildProcessTableIndex(rows)
    for (const [pid, recordedCreationTimeMs] of record.pids) {
      const creationTimeMs = recordedCreationTimeMs ?? index.byPid.get(pid)?.creationTimeMs
      record.pids.set(pid, creationTimeMs)
      for (const row of collectDaemonDescendants(index, pid, creationTimeMs)) {
        record.descendants.set(identityKey(row), row)
      }
    }
  }
  return record
}

/** Reused PIDs with different creation times do not identify the recorded descendants. */
async function waitForDescendantExit(rows: WindowsProcessIdentityRow[]): Promise<void> {
  const deadline = Date.now() + EXIT_WAIT_MS
  let remaining = rows
  while (remaining.length > 0) {
    const table = await readProcessTable()
    if (!table) {
      return
    }
    const live = new Set(table.map(identityKey))
    remaining = remaining.filter((row) => live.has(identityKey(row)))
    if (remaining.length === 0) {
      return
    }
    if (Date.now() >= deadline) {
      const names = remaining
        .map((row) => `${row.name} ${row.pid} (ppid ${row.ppid}, created ${row.creationTimeMs})`)
        .join(', ')
      throw new Error(`Daemon descendants did not exit: ${names}`)
    }
    await sleep(POLL_MS)
  }
}

/** Record before stop: idle retirement may remove PID records after the last client disconnects. */
export async function recordProfileDaemons(userData: string): Promise<void> {
  await recordDaemonTree(join(userData, 'daemon'))
}

/** Authenticate, stop PTYs and require the entire daemon tree to exit. */
export async function killProfileDaemons(userData: string): Promise<void> {
  const daemonDir = join(userData, 'daemon')
  const record = await recordDaemonTree(daemonDir)
  recordedProfiles.delete(daemonDir)
  const daemons = readProfileDaemons(daemonDir)
  const retiring = [...record.pids.keys()].filter(
    (pid) => !daemons.some((daemon) => daemon.pid === pid)
  )
  const results = await Promise.allSettled([
    waitForProcessExit(retiring),
    ...daemons.map(async ({ pid, protocolVersion }) => {
      try {
        await cleanupDaemonForProtocol(daemonDir, protocolVersion, pid)
      } catch (error) {
        // Retirement may close authentication; only OS exit proof can complete cleanup.
        if (
          !(error instanceof DaemonEndpointOwnershipError) ||
          error.message !== 'Daemon cleanup aborted: the expected daemon could not be verified'
        ) {
          throw error
        }
      }
      await waitForProcessExit([pid])
    })
  ])
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length === 0) {
    try {
      await waitForDescendantExit([...record.descendants.values()])
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Profile daemon shutdown incomplete')
  }
}

export async function removeTestRoot(root: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await removeTree(root)
      return
    } catch (error) {
      if (
        attempt >= REMOVE_ATTEMPTS ||
        !['ENOTEMPTY', 'EBUSY', 'EPERM'].includes(errorCode(error) ?? '')
      ) {
        throw error
      }
      await sleep(REMOVE_RETRY_MS)
    }
  }
}
