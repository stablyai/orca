import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'

import {
  createBoundRun,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  LAUNCH_TOKEN,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { checkBoundMailbox } from './orchestration-mailbox-check.test-fixture'

import { RpcDispatcher } from '../../../rpc/dispatcher'
import { ORCHESTRATION_METHODS } from '../../../rpc/methods/orchestration/orchestration'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('orchestration notification mailbox consistency', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('never points direct Run A mail after the pane is rebound to Run B', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const first = createRuntime(db)
    const runA = createBoundRun(db, 'Run A')
    const staleDirectMessage = insertDirectRunMessage(db, runA.id, 'Run A completion')
    const runB = createBoundRun(db, 'Run B', { rebind: true })

    await driveToLiveIdle(first.runtime)
    const checked = await checkBoundMailbox(first.runtime)
    const mismatch = pointerCount(first.write) > 0 && checked.count === 0

    expect(mismatch).toBe(false)
    expect(checked).toMatchObject({
      runId: runB.id,
      deliveryId: null,
      count: 0,
      messages: []
    })
    expect(db.getMessageById(staleDirectMessage.id)).toMatchObject({
      read: 0,
      delivered_at: null
    })
    db.close()
  })

  it('fences the pointed mailbox instead of checking a rebound empty Run', async () => {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const harness = createRuntime(db)
    const runA = createBoundRun(db, 'Run A')
    insertDirectRunMessage(db, runA.id, 'Run A completion')

    await driveToLiveIdle(harness.runtime)
    await vi.advanceTimersByTimeAsync(500)
    expect(harness.write).toHaveBeenCalledWith(
      PTY_ID,
      expect.stringContaining(`orchestration check --run ${runA.id}`)
    )

    db.bindRun({
      runId: runA.id,
      coordinatorHandle: 'term_new_coordinator',
      coordinatorPaneKey:
        '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
    })
    const runB = createBoundRun(db, 'Run B')
    const response = await new RpcDispatcher({
      runtime: harness.runtime,
      methods: ORCHESTRATION_METHODS
    }).dispatch({
      id: 'req-pointed-mailbox-fenced',
      authToken: 'test-auth-token',
      method: 'orchestration.check',
      orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION,
      orchestrationCompatibilityEvidence: {
        terminalHandle: TERMINAL_HANDLE,
        paneKey: PANE_KEY,
        launchToken: LAUNCH_TOKEN
      },
      params: { terminal: TERMINAL_HANDLE, run: runA.id }
    })

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'consumer_fenced' }
    })
    const generic = await checkBoundMailbox(harness.runtime)
    expect(generic).toMatchObject({ runId: runB.id, count: 0 })
    db.close()
  })

  // Main remints duplicate leaf ids at load, so equivalent-pane serialization applies only to window-owned layouts.
})
