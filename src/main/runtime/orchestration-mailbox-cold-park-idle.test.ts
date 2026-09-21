import { rmSync } from 'node:fs'
import { stubWriteSettlement } from '../providers/settled-pty-write-stub'
import type { WriteSettlement } from '../../shared/pty-write-settlement'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  isMailboxPointer,
  insertDirectRunMessage,
  pointerCount,
  PTY_ID,
  TERMINAL_HANDLE,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('orchestration mailbox cold-park idle continuation', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('submits the deferred Enter on same-incarnation idle while the PTY stays parked', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-cold-park-idle-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Cold-park idle Run')
    insertDirectRunMessage(db, run.id, 'Resume retained Enter')

    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 3)
    harness.runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 4)
    await vi.advanceTimersByTimeAsync(0)

    expect(pointerCount(harness.write)).toBe(1)
    expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
    db.close()
  })

  it('submits Enter when idle arrives before the delayed pointer write settles', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-delayed-pointer-idle-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Delayed pointer idle Run')
    insertDirectRunMessage(db, run.id, 'Resume Enter after delayed pointer settlement')
    let settlePointerWrite: ((settlement: WriteSettlement) => void) | undefined
    const recordWrite = harness.write as unknown as (ptyId: string, data: string) => boolean
    harness.runtime.setPtyController({
      write: recordWrite,
      writeWithSettlement: vi.fn((ptyId: string, data: string) => {
        recordWrite(ptyId, data)
        return isMailboxPointer(data)
          ? new Promise<WriteSettlement>((resolve) => {
              settlePointerWrite = resolve
            })
          : Promise.resolve(stubWriteSettlement(true))
      }),
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })

    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)
    expect(settlePointerWrite).toBeDefined()
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 3)
    harness.runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    harness.runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 4)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)

    settlePointerWrite?.(stubWriteSettlement(true))
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
    db.close()
  })

  it('releases a delayed pointer watermark after an explicit check claims the batch', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-delayed-pointer-check-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Delayed pointer check Run')
    insertDirectRunMessage(db, run.id, 'Claim before pointer settlement')
    let settleFirstPointerWrite: ((settlement: WriteSettlement) => void) | undefined
    let pointerWrites = 0
    const recordWrite = harness.write as unknown as (ptyId: string, data: string) => boolean
    harness.runtime.setPtyController({
      write: recordWrite,
      writeWithSettlement: vi.fn((ptyId: string, data: string) => {
        recordWrite(ptyId, data)
        if (!isMailboxPointer(data) || ++pointerWrites > 1) {
          return Promise.resolve(stubWriteSettlement(true))
        }
        return new Promise<WriteSettlement>((resolve) => {
          settleFirstPointerWrite = resolve
        })
      }),
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })

    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(1)
    const checked = await checkBoundMailbox(harness.runtime)
    expect(checked).toMatchObject({ runId: run.id, count: 1 })
    expect(settleFirstPointerWrite).toBeDefined()

    settleFirstPointerWrite?.(stubWriteSettlement(true))
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
    await checkBoundMailbox(harness.runtime, { ack: checked.deliveryId! })

    const later = insertDirectRunMessage(db, run.id, 'Deliver after pointer settlement')
    harness.runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(0)
    expect(pointerCount(harness.write)).toBe(2)

    await vi.advanceTimersByTimeAsync(500)
    expect(harness.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)
    expect(db.getMessageById(later.id)?.delivered_at).toEqual(expect.any(String))
    db.close()
  })
})
