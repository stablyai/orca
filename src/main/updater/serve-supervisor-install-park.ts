import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, realpath, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  ackFileName,
  acksDir,
  bundleCoordinationDir,
  bundleInfoPlistPath,
  formatBundleIdentity,
  isLiveRegistration,
  isProcessAlive,
  parkRecordPath,
  parseServeParkRecord,
  parseServeSupervisorRegistration,
  supervisorsDir,
  SERVE_COMMIT_DEADLINE_MS,
  SERVE_PARK_ACK_WAIT_MS,
  SERVE_PARK_DEADLINE_MS,
  type ServeParkRecord,
  type ServeSupervisorRegistration
} from '../../shared/serve-bundle-coordination'

export type ServeInstallParkResult =
  | { kind: 'parked' }
  /** `unregistered` keeps today's refusal; the others name supervisors that did not cooperate. */
  | { kind: 'refused'; reason: 'unregistered' | 'unresponsive' | 'busy'; pids: number[] }

type ParkDeps = {
  macUserDataRoot: string
  listBlockers: () => Promise<number[]>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  ackWaitMs?: number
}

const ACK_POLL_MS = 500

/** The attempt this process parked, so commit and release find it without a second lookup. */
let activePark: { dir: string; record: ServeParkRecord } | null = null

async function writeRecordDurably(dir: string, record: ServeParkRecord): Promise<void> {
  const target = parkRecordPath(dir)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const temporary = `${target}.${process.pid}.tmp`
  const handle = await open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(record))
    // Why fsync: supervisors trust this record after the installer is gone, even across a panic.
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, target)
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function liveRegistrations(dir: string, now: number): Promise<ServeSupervisorRegistration[]> {
  let names: string[]
  try {
    names = await readdir(supervisorsDir(dir))
  } catch {
    return []
  }
  const registrations = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) =>
        parseServeSupervisorRegistration(await readJson(join(supervisorsDir(dir), name)))
      )
  )
  return registrations.filter(
    (entry): entry is ServeSupervisorRegistration =>
      entry !== null && isLiveRegistration(entry, now) && isProcessAlive(entry.pid)
  )
}

async function readBundleIdentity(bundle: string): Promise<string> {
  try {
    return formatBundleIdentity(await stat(bundleInfoPlistPath(bundle)))
  } catch {
    return formatBundleIdentity(null)
  }
}

/**
 * Before a desktop install: ask registered `orca serve --supervise` services to stop their server
 * and hold. Any blocker that is not such a server is refused exactly as before.
 */
export async function parkServeSupervisorsForInstall(
  executable: string,
  blockers: number[],
  deps: ParkDeps
): Promise<ServeInstallParkResult> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  let bundle: string
  try {
    bundle = await realpath(dirname(dirname(dirname(executable))))
  } catch {
    return { kind: 'refused', reason: 'unregistered', pids: blockers }
  }
  const dir = bundleCoordinationDir(bundle, deps.macUserDataRoot)
  const byChild = new Map<number, ServeSupervisorRegistration>()
  for (const registration of await liveRegistrations(dir, now())) {
    if (registration.childPid !== null) {
      byChild.set(registration.childPid, registration)
    }
  }
  const unregistered = blockers.filter((pid) => !byChild.has(pid))
  if (unregistered.length > 0) {
    return { kind: 'refused', reason: 'unregistered', pids: unregistered }
  }
  const existing = parseServeParkRecord(await readJson(parkRecordPath(dir)))
  if (
    existing &&
    existing.phase === 'park' &&
    existing.installerPid !== process.pid &&
    isProcessAlive(existing.installerPid) &&
    now() < existing.parkDeadlineAt
  ) {
    return { kind: 'refused', reason: 'busy', pids: [existing.installerPid] }
  }
  const supervisorPids = [...new Set(blockers.flatMap((pid) => byChild.get(pid)?.pid ?? []))]
  const createdAt = now()
  const record: ServeParkRecord = {
    schemaVersion: 1,
    attemptId: randomUUID(),
    installerPid: process.pid,
    phase: 'park',
    createdAt,
    parkDeadlineAt: createdAt + SERVE_PARK_DEADLINE_MS,
    commitDeadlineAt: null,
    bundleBefore: await readBundleIdentity(bundle),
    supervisorPids
  }
  await writeRecordDurably(dir, record)
  activePark = { dir, record }

  const deadline = createdAt + (deps.ackWaitMs ?? SERVE_PARK_ACK_WAIT_MS)
  let missing = supervisorPids
  while (now() < deadline) {
    let acked: string[]
    try {
      acked = await readdir(acksDir(dir))
    } catch {
      acked = []
    }
    missing = supervisorPids.filter(
      (pid) =>
        !acked.includes(ackFileName(record.attemptId, pid)) &&
        // A supervisor that died while parking no longer blocks anything.
        isProcessAlive(pid)
    )
    if (missing.length === 0) {
      const remaining = await deps.listBlockers().catch(() => blockers)
      if (remaining.length === 0) {
        return { kind: 'parked' }
      }
      missing = remaining
    }
    await sleep(ACK_POLL_MS)
  }
  await releaseServeSupervisorPark()
  return { kind: 'refused', reason: 'unresponsive', pids: missing }
}

/** Margin so a supervisor polling at the park deadline cannot resume while commit is written. */
const COMMIT_DEADLINE_MARGIN_MS = 5_000

/** Right before the native install: from here supervisors wait for the bundle to change. */
export async function commitServeSupervisorPark(
  listBlockers: () => Promise<number[]>,
  now: () => number = Date.now
): Promise<void> {
  if (!activePark) {
    return
  }
  // Why re-list: a server another supervisor started after the acks would block ShipIt.
  const blockers = await listBlockers().catch(() => null)
  if (blockers === null || blockers.length > 0) {
    await releaseServeSupervisorPark()
    throw new Error('An Orca server started again before the install began.')
  }
  if (now() + COMMIT_DEADLINE_MARGIN_MS >= activePark.record.parkDeadlineAt) {
    // Why throw: supervisors may already have restarted servers that would block ShipIt.
    await releaseServeSupervisorPark()
    throw new Error('Paused Orca serve services resumed before the install began.')
  }
  const record: ServeParkRecord = {
    ...activePark.record,
    phase: 'commit',
    commitDeadlineAt: now() + SERVE_COMMIT_DEADLINE_MS
  }
  await writeRecordDurably(activePark.dir, record)
  activePark = { ...activePark, record }
}

/** Any aborted install: parked supervisors resume the old bundle right away. */
export async function releaseServeSupervisorPark(): Promise<void> {
  const park = activePark
  activePark = null
  if (!park) {
    return
  }
  try {
    await writeRecordDurably(park.dir, { ...park.record, phase: 'unpark' })
  } catch {
    // The park and commit deadlines still end the hold on their own.
  }
}

export function serveInstallRefusalMessage(
  result: Extract<ServeInstallParkResult, { kind: 'refused' }>
): string {
  const pids = result.pids.slice(0, 10).join(', ')
  if (result.reason === 'unresponsive') {
    return `Background orca serve services (process IDs: ${pids}) did not pause for the update in time. Orca remains open; retry the update, or stop those services first.`
  }
  if (result.reason === 'busy') {
    return 'Another Orca window is already installing this update. Orca remains open; retry in a minute.'
  }
  return `Close the other Orca instances (process IDs: ${pids}) before installing this update. Background orca serve instances also need to stop. Orca remains open; retry the update after closing them.`
}
