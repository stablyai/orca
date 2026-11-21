import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { EnrichedAgentHookEventPayload } from '../../../../agent-hooks/server/server-types'
import { agentHookServer } from '../../../../agent-hooks/server/agent-hook-server'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import {
  createBoundRun,
  createRuntime,
  PANE_KEY,
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

function hookObservation(observedAt: number) {
  return {
    origin: 'hook' as const,
    authorityId: 'test-hook-authority',
    incarnation: 1,
    revision: 1,
    observedAt
  }
}

function monitoringDoneRow(at: number): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    connectionId: null,
    state: 'working',
    workingMode: 'monitoring',
    mainAgent: { state: 'done', stateStartedAt: at },
    prompt: '',
    agentType: 'antigravity',
    receivedAt: at,
    stateStartedAt: at,
    observation: hookObservation(at)
  }
}

function insertWorkerDone(db: OrchestrationDb, runId: string, subject: string) {
  return db.insertMessage({
    from: 'term_worker',
    to: `run:${runId}`,
    subject,
    type: 'worker_done',
    runId,
    deliveryContract: 'current_delivery'
  })
}

describe('orchestration mail delivery for Antigravity coordinators in monitoring mode', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('delivers worker_done to an idle Antigravity coordinator held in monitoring mode past 30 minutes', async () => {
    vi.useFakeTimers()
    const turnEndedAt = Date.now()
    const db = new OrchestrationDb(':memory:')
    const harness = await createRuntime(db, {
      launchAgent: 'antigravity',
      getAgentStatusSnapshot: () => [monitoringDoneRow(turnEndedAt)]
    })
    const run = createBoundRun(db, 'Antigravity coordinator Run')
    const enterCount = (): number =>
      harness.write.mock.calls.filter(([, payload]) => payload === '\r').length

    // Matches #46022: coordinator finishes with background tasks, then a worker finishes 47 minutes later.
    await vi.advanceTimersByTimeAsync(47 * 60 * 1000)
    const message = insertWorkerDone(db, run.id, 'Worker finished')
    harness.runtime.deliverPendingMessagesForHandle(`run:${run.id}`)
    await vi.advanceTimersByTimeAsync(500)

    expect(pointerCount(harness.write)).toBe(1)
    expect(enterCount()).toBe(1)
    expect(db.getMessageById(message.id)).toMatchObject({
      delivered_at: expect.any(String),
      pointer_enter_pending: 0
    })
    db.close()
  })

  it('wakes held worker_done mail when a live Antigravity monitoring turn-end hook arrives', async () => {
    vi.useFakeTimers()
    const startedAt = Date.now()
    let currentRows: AgentStatusIpcPayload[] = [
      {
        paneKey: PANE_KEY,
        connectionId: null,
        state: 'working',
        prompt: '',
        agentType: 'antigravity',
        receivedAt: startedAt,
        stateStartedAt: startedAt,
        observation: hookObservation(startedAt)
      }
    ]
    const enrichedListeners = new Set<(row: EnrichedAgentHookEventPayload) => void>()
    const db = new OrchestrationDb(':memory:')
    const harness = await createRuntime(db, {
      launchAgent: 'antigravity',
      getAgentStatusSnapshot: () => currentRows
    })
    const detach = harness.runtime.attachAgentStatusStore({
      getStatusSnapshot: () => currentRows,
      getStatusSnapshotForPane: (paneKey) => currentRows.filter((row) => row.paneKey === paneKey),
      subscribeStatusRowMutations: () => () => {},
      subscribeStatusFreshness: () => () => {},
      subscribeEnrichedStatus: (listener) => {
        enrichedListeners.add(listener)
        return () => enrichedListeners.delete(listener)
      }
    })
    const run = createBoundRun(db, 'Antigravity live hook wake')
    const message = insertWorkerDone(db, run.id, 'Worker finished while coordinator busy')
    const enterCount = (): number =>
      harness.write.mock.calls.filter(([, payload]) => payload === '\r').length

    harness.runtime.deliverPendingMessagesForHandle(`run:${run.id}`)
    await vi.advanceTimersByTimeAsync(500)
    expect(pointerCount(harness.write)).toBe(0)

    const turnEndedAt = Date.now()
    currentRows = [monitoringDoneRow(turnEndedAt)]
    for (const listener of enrichedListeners) {
      listener({
        paneKey: PANE_KEY,
        connectionId: null,
        receivedAt: turnEndedAt,
        stateStartedAt: turnEndedAt,
        observation: hookObservation(turnEndedAt),
        payload: {
          state: 'working',
          workingMode: 'monitoring',
          mainAgent: { state: 'done', stateStartedAt: turnEndedAt },
          prompt: '',
          agentType: 'antigravity'
        }
      })
    }
    await vi.advanceTimersByTimeAsync(500)

    expect(pointerCount(harness.write)).toBe(1)
    expect(enterCount()).toBe(1)
    expect(db.getMessageById(message.id)).toMatchObject({
      delivered_at: expect.any(String),
      pointer_enter_pending: 0
    })
    detach()
    db.close()
  })

  it('delivers unread worker_done mail to a reattached Antigravity coordinator with restored monitoring-done status', async () => {
    vi.useFakeTimers()
    const restoredAt = Date.now() - 60_000
    const db = new OrchestrationDb(':memory:')
    const harness = await createRuntime(db, { launchAgent: null })
    const write = vi.fn((_id: string, _data: string) => true)
    harness.runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => 'agy'
    })
    harness.runtime.startReattachedOutputClock(PTY_ID, {
      pid: 4242,
      incarnationId: 'mailbox-incarnation'
    })
    const run = createBoundRun(db, 'Antigravity restart Run')
    const message = insertWorkerDone(db, run.id, 'Unread before restart')
    const enterCount = (): number =>
      write.mock.calls.filter(([, payload]) => payload === '\r').length
    vi.spyOn(agentHookServer, 'readRestoredAgentStatus').mockResolvedValue({
      state: 'working',
      mainAgent: { state: 'done', stateStartedAt: restoredAt }
    })

    harness.runtime.restoreReattachedAgentStatus(PTY_ID)
    await vi.advanceTimersByTimeAsync(500)

    expect(pointerCount(write)).toBe(1)
    expect(enterCount()).toBe(1)
    expect(db.getMessageById(message.id)).toMatchObject({
      delivered_at: expect.any(String),
      pointer_enter_pending: 0
    })
    db.close()
  })
})
