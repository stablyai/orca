import { rmSync } from 'node:fs'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  isMailboxPointer,
  pointerCount,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { writeToSshPtyWithSettlement } from '../providers/ssh-pty-write'
import {
  MAILBOX_POINTER_ENTER_ATTEMPTED,
  MAILBOX_POINTER_WRITE_ATTEMPTED
} from './orchestration/db/messages/mailbox-pointer-enter-state'

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

  it('durably reserves before transport and redrives a rejected write', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-transport-settlement-')
    const first = createRuntime(db)
    const observedWrite = vi.fn((_ptyId: string, _data: string) => true)
    let settleWrite: ((settlement: WriteSettlement) => void) | undefined
    first.runtime.setPtyController({
      write: observedWrite,
      writeWithSettlement: vi.fn(
        () =>
          new Promise<WriteSettlement>((resolve) => {
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
    expect(db.getMessageById(message.id)).toMatchObject({
      delivered_at: null,
      pointer_enter_pending: MAILBOX_POINTER_WRITE_ATTEMPTED
    })

    settleWrite?.(writeRefused('provider_refused_write'))
    await Promise.resolve()
    await Promise.resolve()
    expect(pointerCount(observedWrite)).toBe(0)
    // Proven refusal releases the reservation outright; ambiguity never may.
    expect(db.getMessageById(message.id)).toMatchObject({
      delivered_at: null,
      pointer_enter_pending: 0
    })

    const restarted = createRuntime(db)
    await driveToLiveIdle(restarted.runtime)
    await Promise.resolve()
    expect(pointerCount(restarted.write)).toBe(1)
    expect(db.getMessageById(message.id)?.delivered_at).toBeNull()
    db.close()
  })

  it('does not replay pointer bytes after an in-flight SSH write loses its settlement', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-ambiguous-settlement-')
    const first = createRuntime(db)
    const transported: Buffer[] = []
    const mux = new SshChannelMultiplexer({
      supportsWriteSettlement: true,
      write: (frame) => {
        transported.push(frame)
        return true
      },
      onData: () => {},
      onClose: () => {}
    })
    const observed: WriteSettlement[] = []
    first.runtime.setPtyController({
      write: vi.fn(() => true),
      writeWithSettlement: (ptyId, data) =>
        writeToSshPtyWithSettlement(mux, ptyId, data).then((settlement) => {
          observed.push(settlement)
          return settlement
        }),
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })
    const run = createBoundRun(db, 'Ambiguous SSH pointer')
    const message = insertDirectRunMessage(db, run.id, 'Keep one pointer')
    await driveToLiveIdle(first.runtime)
    expect(transported).toHaveLength(1)
    mux.dispose('connection_lost')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(observed).toEqual([
      { outcome: 'unverifiable', reason: 'transport_settlement_lost', bytesHandedToTransport: true }
    ])
    expect(db.getMessageById(message.id)?.pointer_enter_pending).toBe(
      MAILBOX_POINTER_WRITE_ATTEMPTED
    )

    const restarted = createRuntime(db)
    await driveToLiveIdle(restarted.runtime)
    expect(pointerCount(restarted.write)).toBe(0)
    expect(db.getMessageById(message.id)?.read).toBe(0)
    db.close()
  })

  it('preserves the reservation when a settled write throws after handing off bytes', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-throwing-settlement-')
    const first = createRuntime(db)
    const observedWrite = vi.fn((_ptyId: string, _data: string) => true)
    first.runtime.setPtyController({
      write: observedWrite,
      writeWithSettlement: (ptyId: string, data: string) => {
        observedWrite(ptyId, data)
        if (isMailboxPointer(data)) {
          throw new Error('relay socket destroyed mid-write')
        }
        return WRITE_ACCEPTED
      },
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })
    const run = createBoundRun(db, 'Throwing SSH pointer')
    const message = insertDirectRunMessage(db, run.id, 'Keep one pointer through a throw')

    await driveToLiveIdle(first.runtime)
    await Promise.resolve()
    expect(pointerCount(observedWrite)).toBe(1)
    // A throw after the bytes may have left is unverifiable, so the claim must survive.
    expect(db.getMessageById(message.id)?.pointer_enter_pending).toBe(
      MAILBOX_POINTER_WRITE_ATTEMPTED
    )

    const restarted = createRuntime(db)
    await driveToLiveIdle(restarted.runtime)
    expect(pointerCount(restarted.write)).toBe(0)
    expect(db.getMessageById(message.id)?.read).toBe(0)
    db.close()
  })

  it('does not replay Enter after its settlement is lost', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-ambiguous-enter-')
    const first = createRuntime(db)
    const observedWrite = vi.fn((_ptyId: string, _data: string) => true)
    first.runtime.setPtyController({
      write: observedWrite,
      writeWithSettlement: (ptyId: string, data: string) => {
        observedWrite(ptyId, data)
        return Promise.resolve(
          data === '\r' ? writeUnverifiable('transport_settlement_lost', true) : WRITE_ACCEPTED
        )
      },
      kill: vi.fn(),
      getForegroundProcess: async () => null
    })
    const run = createBoundRun(db, 'Ambiguous Enter Run')
    const message = insertDirectRunMessage(db, run.id, 'Submit exactly once')

    await driveToLiveIdle(first.runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(enterCount(observedWrite)).toBe(1)
    // Unproven submission: not settled as delivered, and not rolled back to a resendable state.
    expect(db.getMessageById(message.id)).toMatchObject({
      delivered_at: null,
      pointer_enter_pending: MAILBOX_POINTER_ENTER_ATTEMPTED
    })

    const restarted = createRuntime(db)
    await driveToLiveIdle(restarted.runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(enterCount(restarted.write)).toBe(0)
    expect(pointerCount(restarted.write)).toBe(0)
    expect(db.getMessageById(message.id)?.read).toBe(0)
    db.close()
  })
})

function enterCount(write: ReturnType<typeof vi.fn>): number {
  return write.mock.calls.filter(([, payload]) => payload === '\r').length
}
