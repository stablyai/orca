import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settledWriteStub } from '../../../../providers/settled-pty-write-stub'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PTY_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

describe('mail to a Cursor worker under its own status title', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  // cursor-agent titles its pane `<chat> - <emoji> <label>`; Orca writes no working title over it (STA-14266).
  it.each([
    ['Espresso Manufacturer EEAT - ⏳ Working ···'],
    ['Espresso Manufacturer EEAT - ✅ Ready (feature-branch)']
  ])('offers mail while the title is %s', async (title) => {
    vi.useFakeTimers()
    const db = createDatabase('orca-cursor-native-title-')
    const { runtime } = createRuntime(db, { launchAgent: 'cursor' })
    const write = vi.fn((_ptyId: string, _data: string) => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => 'cursor-agent'
    })
    const run = createBoundRun(db, 'Cursor native title Run')
    await runtime.listTerminals()
    insertDirectRunMessage(db, run.id, 'Steer the worker')
    runtime.onPtyData(PTY_ID, `\x1b]0;${title}\x07`, 1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(write).toHaveBeenCalledWith(
      PTY_ID,
      expect.stringContaining('You have 1 orchestration message')
    )
    db.close()
  })
})
