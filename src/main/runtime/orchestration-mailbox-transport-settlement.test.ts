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

describe('orchestration mailbox transport settlement', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not durably stage a pointer until transport settlement succeeds', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-transport-settlement-')
    const first = createRuntime(db)
    const observedWrite = vi.fn((_ptyId: string, _data: string) => true)
    let settleWrite: ((accepted: boolean) => void) | undefined
    first.runtime.setPtyController({
      write: observedWrite,
      writeWithSettlement: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            settleWrite = resolve
          })
      ),
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })
    const run = createBoundRun(db, 'SSH settlement Run')
    const message = insertDirectRunMessage(db, run.id, 'Rejected SSH pointer')

    await driveToLiveIdle(first.runtime)
    expect(pointerCount(observedWrite)).toBe(0)
    expect(db.getMessageById(message.id)?.delivered_at).toBeNull()

    settleWrite?.(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(pointerCount(observedWrite)).toBe(0)
    expect(db.getMessageById(message.id)?.delivered_at).toBeNull()

    const restarted = createRuntime(db)
    await driveToLiveIdle(restarted.runtime)
    await Promise.resolve()
    expect(pointerCount(restarted.write)).toBe(1)
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    db.close()
  })
})
