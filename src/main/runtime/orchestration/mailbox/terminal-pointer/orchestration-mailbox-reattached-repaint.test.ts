import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { agentHookServer } from '../../../../agent-hooks/server/agent-hook-server'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'
import type { RuntimeRepaintResult } from '../../../terminal/lifecycle/runtime-pty-controller-contract'
import {
  createRuntime,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const CLAUDE_COMPOSER = '\x1b[?2031h\x1b[?2004h│ ❯  │\x1b[?25h'
const HELD_SUBJECT = 'Mail to a worker is held after Orca restarted'
// The daemon's output count when this run reattached; the harness registers this incarnation.
const REATTACHED_SEQUENCE = 491

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A restart reattached this idle Claude worker: its composer was drawn before Orca started, its
 *  status comes back from its last hook report. */
async function reattachedIdleWorker(options: { repaint: RuntimeRepaintResult[] }) {
  vi.useFakeTimers()
  const db = new OrchestrationDb(':memory:')
  const harness = await createRuntime(db, { launchAgent: 'claude', foregroundProcess: 'claude' })
  const { runtime, requestRepaint } = harness
  for (const result of options.repaint) {
    requestRepaint.mockResolvedValueOnce(result)
  }
  requestRepaint.mockResolvedValue(options.repaint.at(-1))
  const run = db.createRun({
    objective: 'Reattached worker',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: '55555555-5555-4555-8555-555555555555:66666666-6666-4666-8666-666666666666'
  })
  const task = db.createTask({ spec: 'Worker task', runId: run.id })
  const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
  await runtime.listTerminals()
  vi.spyOn(agentHookServer, 'readRestoredAgentStatus').mockResolvedValue({ state: 'done' })
  runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, {
    value: REATTACHED_SEQUENCE,
    generation: 'continued'
  })
  runtime.startReattachedOutputClock(PTY_ID)
  runtime.restoreReattachedAgentStatus(PTY_ID)
  await vi.advanceTimersByTimeAsync(0)
  await runtime.serializeMainTerminalBuffer(PTY_ID)

  const mailbox = `dispatch:${dispatch.id}`
  const send = (subject: string) => {
    const message = db.insertMessage({
      from: 'term_coordinator',
      to: mailbox,
      subject,
      type: 'handoff',
      runId: run.id
    })
    runtime.deliverPendingMessagesForHandle(mailbox)
    return message
  }
  const paint = async () => {
    runtime.onPtyData(PTY_ID, CLAUDE_COMPOSER, 2)
    await runtime.serializeMainTerminalBuffer(PTY_ID)
  }
  const alerts = () =>
    db
      .getUnreadRunMailbox(run.id, 100, ['escalation'])
      .filter((message) => message.subject === HELD_SUBJECT)
  return { db, ...harness, send, paint, alerts }
}

describe('mail held by a reattached idle agent', () => {
  it('asks a host that can repaint once, then delivers on the paint, as before', async () => {
    const worker = await reattachedIdleWorker({ repaint: ['nudged'] })
    const message = worker.send('After restart')
    expect(pointerCount(worker.write)).toBe(0)

    // Rechecks while the repaint is in flight ask nothing more and raise nothing.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(worker.requestRepaint).toHaveBeenCalledTimes(1)
    expect(worker.requestRepaint).toHaveBeenCalledWith(PTY_ID)
    expect(pointerCount(worker.write)).toBe(0)

    await worker.paint()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pointerCount(worker.write)).toBe(1)
    expect(worker.db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    expect(worker.requestRepaint).toHaveBeenCalledTimes(1)
    expect(worker.alerts()).toEqual([])
    worker.db.close()
  })

  it('tells the coordinator once where the host cannot repaint, and delivers on a later paint', async () => {
    const worker = await reattachedIdleWorker({ repaint: ['unavailable'] })
    const first = worker.send('After a restart')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pointerCount(worker.write)).toBe(0)
    expect(worker.alerts()).toHaveLength(1)
    expect(worker.alerts()[0]?.body).toContain('resize its pane')

    worker.send('Second message, same hold')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(worker.alerts()).toHaveLength(1)
    expect(worker.requestRepaint).toHaveBeenCalledTimes(1)

    await worker.paint()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pointerCount(worker.write)).toBe(1)
    expect(worker.db.getMessageById(first.id)?.delivered_at).toEqual(expect.any(String))
    expect(worker.alerts()).toHaveLength(1)
    worker.db.close()
  })

  it('raises nothing when the repaint request fails, as before', async () => {
    const worker = await reattachedIdleWorker({ repaint: ['nudged'] })
    worker.requestRepaint.mockReset().mockRejectedValue(new Error('daemon unreachable'))
    worker.send('While the daemon is unreachable')

    await vi.advanceTimersByTimeAsync(10_000)
    expect(worker.requestRepaint).toHaveBeenCalledTimes(1)
    expect(pointerCount(worker.write)).toBe(0)
    expect(worker.alerts()).toEqual([])
    worker.db.close()
  })
})
