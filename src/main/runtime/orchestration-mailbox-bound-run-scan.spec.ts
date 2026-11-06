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

describe('orchestration mailbox scan of bound Runs on input edges', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('probes no mail-less Run per edge and still wakes an old Run with unread mail', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-bound-run-scan-')
    const harness = createRuntime(db)
    const runs = Array.from({ length: 200 }, (_, index) => createBoundRun(db, `Run ${index}`))
    await driveToLiveIdle(harness.runtime)
    await vi.advanceTimersByTimeAsync(1_000)
    const pendingProbe = vi.spyOn(db, 'getPendingMailboxPointerMessages')
    const batchProbe = vi.spyOn(db, 'getUndeliveredUnreadMessages')

    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 2)
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 3)
    await vi.advanceTimersByTimeAsync(1_000)
    // Only the current Run is probed; the 199 older Runs without mail are skipped.
    const current = `run:${runs.at(-1)!.id}`
    expect(new Set(pendingProbe.mock.calls.map(([mailbox]) => mailbox))).toEqual(new Set([current]))
    expect(new Set(batchProbe.mock.calls.map(([mailbox]) => mailbox))).toEqual(new Set([current]))

    const old = runs[5]!
    db.insertMessage({
      from: 'term_worker',
      to: `run:${old.id}`,
      subject: 'late',
      type: 'status',
      runId: old.id
    })
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 4)
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 5)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(harness.write).toHaveBeenCalledWith(PTY_ID, expect.stringContaining(`--run ${old.id}`))
    db.close()
  })
})
