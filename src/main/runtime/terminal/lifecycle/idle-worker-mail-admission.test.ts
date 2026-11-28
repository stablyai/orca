import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentProcessVerdict } from '../../../../shared/agent-status/process/agent-process-presence'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import { sendDeliveryHoldWarning } from '../../rpc/methods/orchestration/messaging/send-delivery-hold'
import {
  createBoundRun,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  temporaryDirectories,
  TERMINAL_HANDLE
} from '../../orchestration/mailbox/terminal-pointer/orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

/** The quiet idle worker's own hook row, as the host stores it at rest. */
function idleRow(paneKey = PANE_KEY): AgentStatusIpcPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: admission reads only identity, state and clocks.
  return {
    paneKey,
    state: 'done',
    connectionId: null,
    receivedAt: 1,
    stateStartedAt: 1,
    agentType: 'codex',
    prompt: ''
  } as AgentStatusIpcPayload
}

describe('mail to a quiet idle worker whose terminal lost its live status', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  async function idleWorkerInbox(options: {
    verdict: AgentProcessVerdict | null
    row?: AgentStatusIpcPayload
  }) {
    vi.useFakeTimers()
    const db = new OrchestrationDb(':memory:')
    const rows: AgentStatusIpcPayload[] = [options.row ?? idleRow()]
    const { runtime, write } = await createRuntime(db, {
      launchAgent: 'codex',
      getAgentStatusSnapshotForPane: (paneKey) =>
        paneKey === PANE_KEY ? rows.filter((row) => row.paneKey === paneKey) : [],
      checkHookAgentPresence: async (paneKey) => (paneKey === PANE_KEY ? options.verdict : null)
    })
    await driveToLiveIdle(runtime)
    // A reattached pane whose title is no longer a live status observation, while the hook row says rest.
    runtime.markAgentStatusUnobserved(PTY_ID)
    const run = createBoundRun(db, 'Idle worker')
    const mailbox = `run:${run.id}`
    insertDirectRunMessage(db, run.id, 'Please review the patch.')
    return { db, runtime, write, mailbox }
  }

  it('confirms the recorded process and delivers instead of holding unverified', async () => {
    const { db, runtime, write, mailbox } = await idleWorkerInbox({ verdict: 'live' })
    try {
      expect(runtime.readTerminalMailHold(mailbox)).toEqual({
        kind: 'unverified',
        terminal: TERMINAL_HANDLE
      })

      expect(await sendDeliveryHoldWarning(runtime, db, mailbox)).toBeNull()
      await vi.advanceTimersByTimeAsync(5_000)

      expect(pointerCount(write)).toBe(1)
    } finally {
      db.close()
    }
  })

  it.each(['exited', 'unverifiable', null] as const)(
    'keeps the unverified hold when the process probe answers %s',
    async (verdict) => {
      const { db, runtime, write, mailbox } = await idleWorkerInbox({ verdict })
      try {
        expect(await sendDeliveryHoldWarning(runtime, db, mailbox)).toMatchObject({
          code: 'recipient_delivery_held'
        })
        await vi.advanceTimersByTimeAsync(5_000)
        expect(pointerCount(write)).toBe(0)
      } finally {
        db.close()
      }
    }
  )

  it('does not re-admit a row that is waiting on a human', async () => {
    const { db, runtime, write, mailbox } = await idleWorkerInbox({
      verdict: 'live',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the admission reads only state and clocks.
      row: { ...idleRow(), state: 'waiting' } as AgentStatusIpcPayload
    })
    try {
      expect(await sendDeliveryHoldWarning(runtime, db, mailbox)).toMatchObject({
        code: 'recipient_delivery_held'
      })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(pointerCount(write)).toBe(0)
    } finally {
      db.close()
    }
  })
})
