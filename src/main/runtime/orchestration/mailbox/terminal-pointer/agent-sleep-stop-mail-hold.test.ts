import { rmSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  PTY_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

afterEach(() => {
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('holds mail while Agent Sleep stops the agent, and delivers it once the stop fails', async () => {
  vi.useFakeTimers()
  const db = createDatabase('orca-sleep-stop-hold-')
  const { runtime } = await createRuntime(db)
  const write = vi.fn((_ptyId: string, _data: string) => true)
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: vi.fn(),
    getForegroundProcess: async () => 'codex',
    supportsForegroundObservation: () => true,
    inspectProcess: async () => ({
      foregroundProcess: 'codex',
      hasChildProcesses: true,
      foregroundObservation: {
        ptyId: PTY_ID,
        ptyIncarnationId: 'mailbox-incarnation',
        authorityGeneration: 'test',
        observationEpoch: 1,
        capturedAgeMs: 0,
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: 'non-shell',
        processName: 'codex'
      }
    })
  })
  try {
    const run = createBoundRun(db, 'Coordinator being put to sleep')
    await driveToLiveIdle(runtime)
    const settleStop = runtime.intentionalPtyStops.mark(PTY_ID, 'reversible', 'mailbox-incarnation')
    insertDirectRunMessage(db, run.id, 'Mail during the sleep')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(write).not.toHaveBeenCalled()

    settleStop(false)
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
  } finally {
    db.close()
  }
})
