import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkBoundMailbox,
  createBoundRun,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  pointerCount,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { OrchestrationDb } from './orchestration/db'
import { MAILBOX_POINTER_ENTER_ATTEMPTED } from './orchestration/db/messages/mailbox-pointer-enter-state'

describe('orchestration mailbox crash recovery', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not replay Enter when Enter was accepted before settlement', async () => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-enter-crash-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const firstDb = new OrchestrationDb(dbPath)
    const first = createRuntime(firstDb)
    const run = createBoundRun(firstDb, 'Enter crash Run')
    const message = insertDirectRunMessage(firstDb, run.id, 'Visible before Enter crash')
    const recordWrite = first.write as unknown as (id: string, payload: string) => unknown
    const write = vi.fn((ptyId: string, data: string) => {
      recordWrite(ptyId, data)
      if (data === '\r') {
        firstDb.close()
      }
      return true
    })
    first.runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })

    await driveToLiveIdle(first.runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(first.write)).toBe(1)
    expect(first.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(1)

    const restartedDb = new OrchestrationDb(dbPath)
    expect(restartedDb.getMessageById(message.id)).toMatchObject({
      read: 0,
      delivered_at: null,
      pointer_enter_pending: MAILBOX_POINTER_ENTER_ATTEMPTED
    })
    const restarted = createRuntime(restartedDb)
    await driveToLiveIdle(restarted.runtime)
    await vi.advanceTimersByTimeAsync(500)
    const checked = await checkBoundMailbox(restarted.runtime)

    expect(pointerCount(restarted.write)).toBe(0)
    expect(restarted.write.mock.calls.filter(([, payload]) => payload === '\r')).toHaveLength(0)
    expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
    restartedDb.close()
  })
})
