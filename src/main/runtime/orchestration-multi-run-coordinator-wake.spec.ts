import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  PTY_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

describe('a coordinator of two Runs', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function insertRunReport(db: ReturnType<typeof createDatabase>, runId: string) {
    return db.insertMessage({
      from: 'term_worker',
      to: `run:${runId}`,
      subject: 'earlier Run report',
      type: 'worker_done',
      runId
    })
  }

  it('is woken for its earlier Run with a pointer naming that Run', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-multi-run-wake-')
    const harness = createRuntime(db)
    const runA = createBoundRun(db, 'Run A')
    createBoundRun(db, 'Run B')
    await driveToLiveIdle(harness.runtime)

    const report = insertRunReport(db, runA.id)
    harness.runtime.notifyMessageArrived(`run:${runA.id}`, report.type)
    await vi.advanceTimersByTimeAsync(500)

    expect(harness.write).toHaveBeenCalledWith(
      PTY_ID,
      expect.stringContaining(`orchestration check --run ${runA.id}`)
    )
    db.close()
  })

  it('points at earlier-Run mail that arrived mid-turn on the next idle edge', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-multi-run-idle-')
    const harness = createRuntime(db)
    const runA = createBoundRun(db, 'Run A')
    createBoundRun(db, 'Run B')
    insertRunReport(db, runA.id)

    await driveToLiveIdle(harness.runtime)

    expect(harness.write).toHaveBeenCalledWith(
      PTY_ID,
      expect.stringContaining(`orchestration check --run ${runA.id}`)
    )
    db.close()
  })
})
