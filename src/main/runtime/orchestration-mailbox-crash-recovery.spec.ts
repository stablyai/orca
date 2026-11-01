import { settledWriteStub } from '../providers/settled-pty-write-stub'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  isMailboxPointer,
  pointerCount,
  PTY_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { OrchestrationDb } from './orchestration/db'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './orchestration/db/messages/mailbox-pointer-enter-state'

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
  it.each([
    ['submits the pointer it finds still typed', (pointer: string) => pointer, 1, false],
    ['submits it from the daemon screen on reattach', (pointer: string) => pointer, 1, true],
    ['leaves a pointer the user added to', (pointer: string) => `${pointer} also fix CI`, 0, false],
    ['does not retype into an empty composer', () => '', 0, false]
  ])('after a crash between pointer and Enter, %s', async (_name, draftOf, enters, reattach) => {
    vi.useFakeTimers()
    const directory = mkdtempSync(join(tmpdir(), 'orca-mailbox-pointer-crash-'))
    temporaryDirectories.push(directory)
    const dbPath = join(directory, 'orchestration.db')
    const firstDb = new OrchestrationDb(dbPath)
    const first = createRuntime(firstDb)
    const run = createBoundRun(firstDb, 'Pointer crash Run')
    const message = insertDirectRunMessage(firstDb, run.id, 'Typed before the crash')
    const write = vi.fn((_ptyId: string, data: string) => {
      if (isMailboxPointer(data)) {
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
    const pointer = String(write.mock.calls.find(([, data]) => isMailboxPointer(data))?.[1])
    const restartedDb = new OrchestrationDb(dbPath)
    expect(restartedDb.getMessageById(message.id)).toMatchObject({
      delivered_at: null,
      pointer_enter_pending: MAILBOX_POINTER_WRITE_ATTEMPTED
    })
    const restarted = createRuntime(restartedDb)
    const reattachWrite = vi.fn((_ptyId: string, _data: string) => true)
    await restarted.runtime.listTerminals()
    // The surviving PTY still shows its composer, with whatever the crash left in it.
    const screen = `\x1b[2J\x1b[H${'\u2500'.repeat(40)}\r\n\u276F ${draftOf(pointer.trim())}`
    if (reattach) {
      // Only the daemon holds the screen; main's model starts partial after reattach.
      restarted.runtime.setPtyController({
        write: reattachWrite,
        writeWithSettlement: settledWriteStub(reattachWrite),
        kill: vi.fn(),
        getForegroundProcess: async () => null,
        serializeProviderBuffer: async () => ({
          data: screen,
          cols: 80,
          rows: 24,
          seq: 10_000,
          source: 'headless' as const,
          alternateScreen: false
        })
      })
      restarted.runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, {
        value: 5_000,
        generation: 'continued'
      })
      // An earlier capture learns an inline (normal-screen) agent, as for Claude Code.
      await restarted.runtime.serializeHiddenOutputRecoveryBuffer(PTY_ID)
    } else {
      restarted.runtime.onPtyData(PTY_ID, screen, 1)
    }
    await driveToLiveIdle(restarted.runtime)
    await vi.advanceTimersByTimeAsync(500)

    const writes = reattach ? reattachWrite.mock.calls : restarted.write.mock.calls
    expect(writes.filter(([, data]) => isMailboxPointer(data))).toHaveLength(0)
    expect(writes.filter(([, data]) => data === '\r')).toHaveLength(enters)
    expect(restartedDb.getMessageById(message.id)).toMatchObject({
      read: 0,
      delivered_at: expect.any(String),
      pointer_enter_pending: 0
    })
    restartedDb.close()
  })
  it('rescans mailboxes a crash left mid-pointer, including dispatch mailboxes', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-restart-scan-')
    const run = createBoundRun(db, 'restart scan')
    const parked = db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: 'parked mid-pointer',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })
    // The crash left the reservation durable, which hides the row from the undelivered scan.
    expect(
      db.stageMailboxPointerEnter([parked.id], { ptyId: 'pty-gone', processIncarnation: 'gone:1' })
    ).toBe(true)
    db.insertMessage({
      from: 'term_coordinator',
      to: 'dispatch:dispatch_restart_scan',
      subject: 'dispatch mail',
      runId: run.id,
      deliveryContract: 'current_delivery'
    })

    const { runtime } = createRuntime(db)
    const repointed: string[] = []
    vi.spyOn(
      runtime as unknown as { repointPendingMessagesForHandle: (handle: string) => void },
      'repointPendingMessagesForHandle'
    ).mockImplementation((handle: string) => {
      repointed.push(handle)
    })
    runtime.setOrchestrationDb(db)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(repointed).toContain(`run:${run.id}`)
    expect(repointed).toContain('dispatch:dispatch_restart_scan')
    db.close()
  })
})
