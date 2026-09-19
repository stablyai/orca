import { writeRefused, type WriteSettlement } from '../../shared/pty-write-settlement'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  pointerCount,
  PTY_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

function writePointer(
  runtime: unknown,
  ptyId: string,
  data: string
): WriteSettlement | Promise<WriteSettlement> {
  return (
    runtime as {
      writeOrchestrationPointerPty: (
        ptyId: string,
        data: string
      ) => WriteSettlement | Promise<WriteSettlement>
    }
  ).writeOrchestrationPointerPty.call(runtime, ptyId, data)
}

describe('orchestration mailbox PTY write gate', () => {
  afterEach(() => {
    vi.useRealTimers()
    agentSessionPtyWriteGate.detachRecordLookup()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('withholds pointer and Enter bytes from a bound lease the write gate refuses', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-pty-write-gate-refused-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Refused structured session')
    insertDirectRunMessage(db, run.id, 'Do not write into native chat')
    const lease = agentSessionLeaseFixture({ runtimeKind: 'native' })
    agentSessionPtyWriteGate.attachRecordLookup((sessionId) =>
      sessionId === lease.sessionId ? agentSessionRecordFixture(lease) : null
    )
    agentSessionPtyWriteGate.bindPty(PTY_ID, lease.sessionId)

    await driveToLiveIdle(harness.runtime)

    expect(pointerCount(harness.write)).toBe(0)
    expect(await writePointer(harness.runtime, PTY_ID, 'orchestration check')).toEqual(
      writeRefused('write_gate_denied')
    )
    expect(await writePointer(harness.runtime, PTY_ID, '\r')).toEqual(
      writeRefused('write_gate_denied')
    )
    expect(harness.write).not.toHaveBeenCalled()
    db.close()
  })

  it('keeps an explicitly unbound legacy terminal on the pointer write path', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-pty-write-gate-unbound-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Legacy terminal mailbox')
    insertDirectRunMessage(db, run.id, 'Legacy pointer')
    const lease = agentSessionLeaseFixture({ runtimeKind: 'native' })
    agentSessionPtyWriteGate.attachRecordLookup((sessionId) =>
      sessionId === lease.sessionId ? agentSessionRecordFixture(lease) : null
    )
    agentSessionPtyWriteGate.bindPty('another-pty', lease.sessionId)

    await driveToLiveIdle(harness.runtime)

    expect(pointerCount(harness.write)).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
    db.close()
  })

  it('keeps mailbox pointer delivery working for an admitted bound TUI lease', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-pty-write-gate-admitted-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Admitted structured session')
    insertDirectRunMessage(db, run.id, 'Admitted pointer')
    const lease = agentSessionLeaseFixture()
    agentSessionPtyWriteGate.attachRecordLookup((sessionId) =>
      sessionId === lease.sessionId ? agentSessionRecordFixture(lease) : null
    )
    agentSessionPtyWriteGate.bindPty(PTY_ID, lease.sessionId)

    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)
    await vi.advanceTimersByTimeAsync(500)

    expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
    db.close()
  })
})
