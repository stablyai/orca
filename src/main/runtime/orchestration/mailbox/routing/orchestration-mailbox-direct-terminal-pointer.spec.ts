import { CheckMailReconciliation } from '../../../rpc/methods/orchestration/messaging/check-mail-reconciliation'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkDirectMailbox } from '../../../rpc/methods/orchestration/messaging/check-direct'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  pointerCount,
  SECOND_PANE_KEY,
  SECOND_TERMINAL_HANDLE,
  sqliteFor,
  temporaryDirectories,
  TERMINAL_HANDLE
} from '../terminal-pointer/orchestration-mailbox-notification-test-harness'

describe('orchestration direct terminal mailbox pointer', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('points and checks an unbound pane at its own direct mail but leaves Run-owned rows for routing', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mailbox-direct-terminal-pointer-')
    const harness = createRuntime(db)
    const formerRun = createBoundRun(db, 'Former coordinator Run')
    const runOwned = insertDirectRunMessage(db, formerRun.id, 'Former Run completion')
    db.bindRun({
      runId: formerRun.id,
      coordinatorHandle: SECOND_TERMINAL_HANDLE,
      coordinatorPaneKey: SECOND_PANE_KEY
    })
    sqliteFor(db)
      .prepare('UPDATE messages SET to_handle = ? WHERE id = ?')
      .run(TERMINAL_HANDLE, runOwned.id)
    const peerRun = db.createRun({
      objective: 'Peer Run',
      coordinatorHandle: SECOND_TERMINAL_HANDLE,
      coordinatorPaneKey: SECOND_PANE_KEY
    })
    const plain = db.insertMessage({
      from: 'term_peer',
      to: TERMINAL_HANDLE,
      subject: 'Direct status',
      type: 'status'
    })
    const fromPeerRun = db.insertMessage({
      from: SECOND_TERMINAL_HANDLE,
      to: TERMINAL_HANDLE,
      subject: 'Peer Run status',
      type: 'status',
      runId: peerRun.id
    })

    await driveToLiveIdle(harness.runtime)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(pointerCount(harness.write)).toBe(1)
    expect(db.getMessageById(plain.id)?.delivered_at).not.toBeNull()
    expect(db.getMessageById(fromPeerRun.id)?.delivered_at).not.toBeNull()
    expect(db.getMessageById(runOwned.id)).toMatchObject({
      to_handle: TERMINAL_HANDLE,
      delivered_at: null
    })
    await expect(
      checkDirectMailbox({
        params: {},
        runtime: harness.runtime,
        db,
        handle: TERMINAL_HANDLE,
        typeFilter: undefined,
        signal: undefined,
        reconciliation: new CheckMailReconciliation(harness.runtime, db),
        revalidateConsumer: () => {}
      })
    ).resolves.toMatchObject({ count: 2 })
    expect(db.getMessageById(runOwned.id)?.read).toBe(0)
    db.close()
  })
})
