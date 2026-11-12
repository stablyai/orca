import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import {
  createRuntime,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  TAB_ID,
  LEAF_ID,
  WORKTREE_ID
} from './orchestration-mailbox-notification-test-harness'

type Host = 'headless' | 'window-empty-graph' | 'window-graph-unavailable'

// Mail follows the terminal: a headless serve, or a window with no pane for it, still points it.
async function coordinator(host: Host = 'headless') {
  const db = new OrchestrationDb(':memory:')
  const { runtime, write } = createRuntime(db, { headless: host === 'headless' })
  if (host !== 'headless') {
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  }
  const [terminal] = (await runtime.listTerminals()).terminals
  const run = db.createRun({
    objective: 'Headless Run',
    coordinatorHandle: terminal.handle,
    coordinatorPaneKey: PANE_KEY
  })
  if (host === 'window-graph-unavailable') {
    runtime.markGraphUnavailable(1)
  }
  const sendRunMail = () => {
    const message = db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      subject: 'Worker complete',
      type: 'worker_done',
      runId: run.id
    })
    runtime.notifyMessageArrived(`run:${run.id}`, 'worker_done')
    return message
  }
  return { db, runtime, write, sendRunMail }
}

async function goIdle(runtime: OrcaRuntimeService): Promise<void> {
  runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 1)
  runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 2)
  await runtime.serializeMainTerminalBuffer(PTY_ID)
}

describe('orchestration mailbox pointer for a terminal no pane shows', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('points an already idle coordinator at Run mail', async () => {
    const { db, runtime, write, sendRunMail } = await coordinator()
    await goIdle(runtime)

    const message = sendRunMail()
    await vi.advanceTimersByTimeAsync(0)
    expect(pointerCount(write)).toBe(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(write).toHaveBeenCalledWith(PTY_ID, '\r')
    expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    db.close()
  })

  it('types into no PTY while two live PTYs claim the coordinator pane', async () => {
    const { db, runtime, write, sendRunMail } = await coordinator()
    runtime.registerPty('pty-mailbox-replacement', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'mailbox-replacement-incarnation'
    })
    await runtime.listTerminals()
    await goIdle(runtime)
    sendRunMail()
    await vi.advanceTimersByTimeAsync(3_500)
    expect(pointerCount(write)).toBe(0)
    db.close()
  })

  it('withholds Enter when a second PTY claims the pane after the pointer was typed', async () => {
    const { db, runtime, write, sendRunMail } = await coordinator()
    await goIdle(runtime)
    sendRunMail()
    await vi.advanceTimersByTimeAsync(0)
    expect(pointerCount(write)).toBe(1)

    runtime.registerPty('pty-mailbox-replacement', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: 'mailbox-replacement-incarnation'
    })
    await vi.advanceTimersByTimeAsync(500)
    expect(write).not.toHaveBeenCalledWith(PTY_ID, '\r')
    db.close()
  })

  it('still points an idle coordinator after a desktop promotion is cancelled', async () => {
    const { db, runtime, write, sendRunMail } = await coordinator()
    await goIdle(runtime)
    runtime.attachWindow(1)
    runtime.markGraphUnavailable(1)

    sendRunMail()
    await vi.advanceTimersByTimeAsync(0)
    expect(pointerCount(write)).toBe(1)
    db.close()
  })

  // A serve window that retracted the pane is indistinguishable from STA-11630's unopened workspace.
  it('points a PTY whose pane a serve window retracted before it closed', async () => {
    const { db, runtime, write, sendRunMail } = await coordinator()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Codex',
          activeLeafId: LEAF_ID,
          layout: null
        }
      ],
      leaves: [
        { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: PTY_ID }
      ]
    })
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.markGraphUnavailable(1)
    await goIdle(runtime)
    sendRunMail()
    await vi.advanceTimersByTimeAsync(0)
    expect(pointerCount(write)).toBe(1)
    db.close()
  })

  // STA-11630: a window that shows no pane for the terminal (its workspace is not open) must not hide its mail.
  it.each(['window-empty-graph', 'window-graph-unavailable'] as const)(
    'points a coordinator no pane shows on a %s host',
    async (host) => {
      const { db, runtime, write, sendRunMail } = await coordinator(host)
      await goIdle(runtime)
      sendRunMail()
      await vi.advanceTimersByTimeAsync(0)
      expect(pointerCount(write)).toBe(1)
      db.close()
    }
  )
})
