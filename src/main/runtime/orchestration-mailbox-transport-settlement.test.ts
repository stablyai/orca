import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  pointerCount,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('orchestration mailbox prompt settlement', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not replay a mutated pointer when lifecycle acknowledgement is missing', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-prompt-settlement-')
    const first = createRuntime(db)
    const observedWrite = vi.fn((ptyId: string, data: string) => {
      if (data.includes('\x1b[201~')) {
        first.runtime.onPtyData(ptyId, '\x1b[?25h', Date.now())
      }
      return true
    })
    first.runtime.setPtyController({
      write: observedWrite,
      kill: vi.fn(),
      getForegroundProcess: async () => 'codex'
    })
    const run = createBoundRun(db, 'Unknown prompt settlement Run')
    const message = insertDirectRunMessage(db, run.id, 'Unacknowledged pointer')

    await driveToLiveIdle(first.runtime)
    expect(pointerCount(observedWrite)).toBe(1)
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))

    await vi.runAllTimersAsync()
    expect(observedWrite.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1)
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))

    const restarted = createRuntime(db)
    await driveToLiveIdle(restarted.runtime)
    expect(pointerCount(restarted.write)).toBe(0)
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    db.close()
  })

  it('durably suppresses replay before an ambiguous provider transport attempt', async () => {
    let settleWrite!: (accepted: boolean) => void
    const db = createDatabase('orca-mailbox-host-settlement-')
    const harness = createRuntime(db)
    const writeWithSettlement = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settleWrite = resolve
        })
    )
    harness.runtime.setPtyController({
      write: vi.fn(() => true),
      writeWithSettlement,
      kill: vi.fn(),
      getForegroundProcess: async () => 'codex'
    })
    const run = createBoundRun(db, 'Provider settlement Run')
    const message = insertDirectRunMessage(db, run.id, 'Awaiting transport settlement')

    await driveToLiveIdle(harness.runtime)
    expect(writeWithSettlement).toHaveBeenCalledOnce()
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))

    settleWrite(false)
    for (let turn = 0; turn < 20; turn += 1) {
      await Promise.resolve()
    }

    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    expect(db.getMessageById(message.id)?.delivery_state).toBe('unknown')
    const restarted = createRuntime(db)
    await driveToLiveIdle(restarted.runtime)
    expect(pointerCount(restarted.write)).toBe(0)
    db.close()
  })

  it('does not attempt provider input when durable staging fails', async () => {
    const db = createDatabase('orca-mailbox-staging-failure-')
    const harness = createRuntime(db)
    const writeWithSettlement = vi.fn(async () => true)
    harness.runtime.setPtyController({
      write: vi.fn(() => true),
      writeWithSettlement,
      kill: vi.fn(),
      getForegroundProcess: async () => 'codex'
    })
    const run = createBoundRun(db, 'Staging failure Run')
    const message = insertDirectRunMessage(db, run.id, 'Must remain explicit')
    vi.spyOn(db, 'markAsDeliveryStaged').mockImplementation(() => {
      throw new Error('disk unavailable')
    })

    await driveToLiveIdle(harness.runtime)
    expect(writeWithSettlement).not.toHaveBeenCalled()
    expect(db.getMessageById(message.id)?.delivered_at).toBeNull()
    db.close()
  })
})
