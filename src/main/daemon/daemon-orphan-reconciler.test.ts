import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonOrphanReconciler } from './daemon-orphan-reconciler'
import { PtyOwnershipRecorder } from './pty-ownership-recorder'
import { PtyOwnershipRecordStore, getPtyOwnershipRecordPath } from './pty-ownership-record-store'
import type { PtyOwnershipRecord } from './pty-ownership-record'

// Every correlation this exercises — parentage and `ps` start time — is POSIX. On
// Windows a PTY's descendants belong to its job object, which teardown already terminates.
const describePosix = process.platform === 'win32' ? describe.skip : describe

const cleanups: (() => void)[] = []

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    )
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isRunning(pid)) {
      return true
    }
    await delay(100)
  }
  return !isRunning(pid)
}

/**
 * A process that ignores SIGTERM in its own process group with no parent to reap it — the shape
 * of what a killed daemon leaves behind. `detached` puts it in a fresh session, so its group id
 * is its own pid and nothing in the test runner's ancestry shares it.
 *
 * It ignores SIGTERM on purpose: that is what forces the identity-checked SIGKILL escalation to
 * be the thing under test rather than the polite first signal.
 */
function spawnOrphan(): ChildProcess {
  const child = spawn('/bin/sh', ['-c', 'trap "" TERM; exec sleep 120'], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  cleanups.push(() => {
    if (child.pid && isRunning(child.pid)) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
  })
  return child
}

function makeStore(): PtyOwnershipRecordStore {
  const dir = mkdtempSync(join(tmpdir(), 'orca-orphan-reconcile-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return new PtyOwnershipRecordStore(getPtyOwnershipRecordPath(dir, 42))
}

function readRecords(store: PtyOwnershipRecordStore): PtyOwnershipRecord[] {
  const read = store.read()
  return read.status === 'readable' ? read.records : []
}

/** The reconciling daemon. It shares the test runner's pid with PRIOR_DAEMON, and only the start
 *  time tells them apart — the same way a restarted daemon that drew the same pid is told apart. */
const THIS_DAEMON = { pid: process.pid, startedAtMs: Date.now() }
/** A daemon that died before its sessions were torn down: the case the reaper exists for. */
const PRIOR_DAEMON = { pid: process.pid, startedAtMs: Date.now() - 10 * 60 * 60_000 }

/** Record a root the way the daemon does, then flush the batch rather than wait out its delay. */
async function recordRoot(
  store: PtyOwnershipRecordStore,
  pid: number,
  daemon: { pid: number; startedAtMs: number } = PRIOR_DAEMON
): Promise<void> {
  const recorder = new PtyOwnershipRecorder({ store, daemon, isLive: () => true })
  recorder.record({ sessionId: 'session-a', incarnationId: 'inc-1', pid })
  await recorder.flush()
}

/** Age the record past the spawn grace, which is what a record written before a restart is. */
function backdate(store: PtyOwnershipRecordStore, ageMs: number): PtyOwnershipRecord {
  const [current] = readRecords(store)
  const aged = { ...current, recordedAt: Date.now() - ageMs }
  store.upsert(aged)
  return aged
}

/**
 * A shell that leaves one process behind in its own group, then dies — the reported leak. A live
 * tick writes the survivor down first, then the root is killed with nothing torn down.
 */
async function strandSurvivor(daemon: { pid: number; startedAtMs: number }): Promise<{
  store: PtyOwnershipRecordStore
  survivorPid: number
}> {
  const store = makeStore()
  const dir = mkdtempSync(join(tmpdir(), 'orca-orphan-child-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const childPidFile = join(dir, 'child.pid')

  const root = spawn(
    '/bin/sh',
    ['-c', `(trap "" TERM; exec sleep 120) & echo $! > ${childPidFile}; exec sleep 121`],
    { detached: true, stdio: 'ignore' }
  )
  root.unref()
  const rootPid = root.pid!
  cleanups.push(() => {
    try {
      process.kill(-rootPid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  })
  await delay(1_300)

  await recordRoot(store, rootPid, daemon)
  const survivorPid = Number(readFileSync(childPidFile, 'utf8').trim())
  expect(Number.isSafeInteger(survivorPid) && survivorPid > 0).toBe(true)

  // While the session is live, a tick writes down the tree it can still walk from the root.
  await new DaemonOrphanReconciler({
    store,
    daemonStartedAtMs: daemon.startedAtMs,
    listLiveSessions: () => [{ sessionId: 'session-a', incarnationId: 'inc-1', pid: rootPid }],
    log: () => {}
  }).runOnce()
  expect(readRecords(store)[0].processes.map((entry) => entry.pid)).toEqual([survivorPid])
  backdate(store, 10 * 60_000)

  // The root dies without ever tearing anything down — a crash, a force quit, an updater.
  process.kill(rootPid, 'SIGKILL')
  expect(await waitForExit(rootPid, 5_000)).toBe(true)
  expect(isRunning(survivorPid)).toBe(true)

  return { store, survivorPid }
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()!()
  }
})

describePosix('DaemonOrphanReconciler against real processes', () => {
  it('reaps a group the daemon lost across a restart, then retires the record', async () => {
    const store = makeStore()
    const child = spawnOrphan()
    const pid = child.pid!
    // `ps` prints whole seconds and the delayed SIGKILL refuses a pid born in the capture second,
    // so let the child cross a second boundary before it is ever captured.
    await delay(1_300)

    await recordRoot(store, pid)

    const recorded = backdate(store, 10 * 60_000)
    expect(recorded.root.pid).toBe(pid)
    expect(recorded.root.startedAt).not.toBeNull()
    expect(recorded.pgids).toEqual([pid])

    const events: { event: string; details?: Record<string, unknown> }[] = []
    const reconciler = new DaemonOrphanReconciler({
      store,
      daemonStartedAtMs: THIS_DAEMON.startedAtMs,
      // The daemon restart: the persisted record survives, the in-memory session map does not.
      listLiveSessions: () => [],
      log: (event, details) => events.push({ event, ...(details ? { details } : {}) }),
      escalationGraceMs: 300
    })

    // First tick only observes: nothing derived from a live root may be signalled on first sight.
    await reconciler.runOnce()
    expect(isRunning(pid)).toBe(true)
    expect(events.some((entry) => entry.event === 'pty-orphan-reap')).toBe(false)

    await reconciler.runOnce()
    expect(await waitForExit(pid, 15_000)).toBe(true)

    const reap = events.find((entry) => entry.event === 'pty-orphan-reap')
    expect(reap?.details).toMatchObject({
      sessionId: 'session-a',
      incarnationId: 'inc-1',
      reason: 'stranded_root',
      pgids: [pid],
      processCount: 1
    })

    // The kill is asynchronous, so the record survives the tick that ordered it and is retired by
    // the tick that observes the processes are actually gone.
    expect(readRecords(store)).toHaveLength(1)
    await reconciler.runOnce()
    expect(readRecords(store)).toEqual([])
  }, 45_000)

  it('finds a survivor the root left behind, which is what no parent walk can still reach', async () => {
    const { store, survivorPid } = await strandSurvivor(PRIOR_DAEMON)
    const events: { event: string; details?: Record<string, unknown> }[] = []
    const reconciler = new DaemonOrphanReconciler({
      store,
      daemonStartedAtMs: THIS_DAEMON.startedAtMs,
      listLiveSessions: () => [],
      log: (event, details) => events.push({ event, ...(details ? { details } : {}) }),
      escalationGraceMs: 300
    })
    await reconciler.runOnce()
    expect(isRunning(survivorPid)).toBe(true)

    await reconciler.runOnce()
    expect(await waitForExit(survivorPid, 15_000)).toBe(true)
    expect(events.find((entry) => entry.event === 'pty-orphan-reap')?.details).toMatchObject({
      sessionId: 'session-a',
      reason: 'orphaned_descendant',
      pids: [survivorPid]
    })
  }, 45_000)

  it('leaves what a session left behind to the daemon it ended under', async () => {
    // `nohup server & exit`: the session ended under this still-running daemon. The last live
    // tick's snapshot is not kill authority for anything that outlived that teardown.
    const { store, survivorPid } = await strandSurvivor(THIS_DAEMON)

    const reconciler = new DaemonOrphanReconciler({
      store,
      daemonStartedAtMs: THIS_DAEMON.startedAtMs,
      listLiveSessions: () => [],
      log: () => {},
      escalationGraceMs: 300
    })
    await reconciler.runOnce()
    await reconciler.runOnce()

    await delay(1_000)
    expect(isRunning(survivorPid)).toBe(true)
    expect(readRecords(store)).toEqual([])
  }, 45_000)

  it('leaves a recorded process alone while its session is still live', async () => {
    const store = makeStore()
    const child = spawnOrphan()
    const pid = child.pid!
    await delay(1_300)

    await recordRoot(store, pid)
    backdate(store, 10 * 60_000)

    const reconciler = new DaemonOrphanReconciler({
      store,
      daemonStartedAtMs: THIS_DAEMON.startedAtMs,
      listLiveSessions: () => [{ sessionId: 'session-a', incarnationId: 'inc-1', pid }],
      log: () => {},
      escalationGraceMs: 300
    })
    await reconciler.runOnce()
    await reconciler.runOnce()

    await delay(1_000)
    expect(isRunning(pid)).toBe(true)
    // A live record is re-derived rather than retired, and its clock keeps moving.
    expect(readRecords(store)[0].recordedAt).toBeGreaterThan(Date.now() - 10 * 60_000)
  }, 45_000)

  it('refuses to signal a process whose recorded root identity no longer matches', async () => {
    const store = makeStore()
    const child = spawnOrphan()
    const pid = child.pid!
    await delay(1_300)

    await recordRoot(store, pid)

    // The pid was recycled: same number, a process that started long before ours.
    const [current] = readRecords(store)
    store.upsert({
      ...current,
      root: { pid, startedAt: 'Mon Jan 1 00:00:00 2001' },
      recordedAt: Date.now() - 10 * 60_000
    })

    const reconciler = new DaemonOrphanReconciler({
      store,
      daemonStartedAtMs: THIS_DAEMON.startedAtMs,
      listLiveSessions: () => [],
      log: () => {},
      escalationGraceMs: 300
    })
    await reconciler.runOnce()
    await reconciler.runOnce()

    await delay(1_000)
    expect(isRunning(pid)).toBe(true)
  }, 45_000)

  it('does nothing at all on Windows, where the job object already owns the tree', async () => {
    const store = makeStore()
    store.upsert({
      sessionId: 'session-a',
      incarnationId: 'inc-1',
      root: { pid: 500, startedAt: 'Mon Sep 21 09:00:00 2026' },
      processes: [],
      pgids: [500],
      tty: null,
      daemon: { pid: 400, startedAtMs: 1 },
      recordedAt: 1
    })
    let captures = 0
    const reconciler = new DaemonOrphanReconciler({
      store,
      daemonStartedAtMs: THIS_DAEMON.startedAtMs,
      listLiveSessions: () => [],
      log: () => {},
      platform: 'win32',
      readTable: async () => {
        captures += 1
        return { rows: [], capturedAtMs: Date.now() }
      }
    })

    reconciler.start()
    await reconciler.runOnce()

    expect(captures).toBe(0)
    // A record that ages out on a POSIX host must still be sitting there untouched here.
    expect(readRecords(store)).toHaveLength(1)
  })
})
