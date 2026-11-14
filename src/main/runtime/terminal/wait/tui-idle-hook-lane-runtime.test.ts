import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import '../../orchestration/db/contract-constants'
import '../../orchestration/db/messages/mailbox-routing-page'
import '../../orchestration/db/dispatch-row-writer'
import '../../orchestration/db/attempt-outcome-projection'
import { settledWriteStub } from '../../../providers/testing/settled-pty-write-stub'
import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'

import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('Canonical hook status readiness', () => {
  // The harness pane's identity (agent-transcript-pane-test-harness.ts).
  const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
  const OTHER_PANE_KEY = makePaneKey('tab-9', '99999999-9999-4999-8999-999999999999')
  // A Pi turn in progress: no ready sign the other lanes could settle on.
  const BUSY_SCREEN = '⠋ Working...\r\n'
  // A Codex turn in progress, which Codex's screen rules read as busy.

  // OpenCode 1.18's permission dialog, as the line tail keeps it after the prompt is answered.
  const OPENCODE_PERMISSION_DIALOG = [
    '△ Permission required',
    '# Shell command',
    '$ echo hi',
    ' Allow once   Allow always   Reject     ctrl+f fullscreen  ⇆ select  enter confirm',
    ''
  ].join('\r\n')
  // OpenCode 1.18's question tool, which paints no dialog wording the blocked layer knows.

  // Shorter than the 2 s poll, so only the synchronous verdict can settle a wait.
  const WAIT_MS = 150

  function row(overrides: Partial<AgentStatusIpcPayload> = {}): AgentStatusIpcPayload {
    const now = Date.now()
    return {
      paneKey: PANE_KEY,
      connectionId: null,
      state: 'done',
      prompt: '',
      agentType: 'pi',
      receivedAt: now,
      stateStartedAt: now,
      ...overrides
    }
  }

  async function waitOutcome(options: {
    rows: (handle: string) => AgentStatusIpcPayload[]
    launchAgent?: TuiAgent
    data?: string
    afterCreate?: (runtime: OrcaRuntimeService, handle: string) => unknown
  }): Promise<string> {
    let handle = ''
    const pane = await createTranscriptPane(
      {
        paneTitle: 'Terminal',
        foregroundProcess: options.launchAgent ?? 'pi',
        data: options.data ?? BUSY_SCREEN,
        launchAgent: options.launchAgent ?? 'pi'
      },
      { getAgentStatusSnapshot: () => options.rows(handle) }
    )
    handle = pane.handle
    await options.afterCreate?.(pane.runtime, pane.handle)
    try {
      const result = await pane.runtime.waitForTerminal(pane.handle, {
        condition: 'tui-idle',
        timeoutMs: WAIT_MS
      })
      return result.blockedReason ? `blocked:${result.blockedReason}` : 'ready'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('tui-idle hook lane through the runtime', () => {
    it('joins a row on the terminal handle when its pane key is not the pane', async () => {
      expect(
        await waitOutcome({
          rows: (handle) => [row({ paneKey: OTHER_PANE_KEY, terminalHandle: handle })]
        })
      ).toBe('ready')
    })

    // Input starts a possible new turn, including typed agent restarts; prior done hooks cannot settle it.

    // Pi brackets each message in OSC 133 zones itself, so a command marker is no process boundary.
    it('keeps the row while the agent paints its own shell-integration markers', async () => {
      expect(
        await waitOutcome({
          rows: () => [row({ receivedAt: Date.now() - 1000 })],
          data: `\x1b]133;A\x07OK\x1b]133;C\x07${BUSY_SCREEN}`
        })
      ).toBe('ready')
    })

    it("settles past a denied prompt's dialog text once the hook says the turn ended", async () => {
      const options = { launchAgent: 'opencode' as const, data: OPENCODE_PERMISSION_DIALOG }
      expect(await waitOutcome({ ...options, rows: () => [] })).toBe(
        'blocked:agent-interactive-prompt'
      )
      expect(
        await waitOutcome({
          ...options,
          rows: () => [row({ agentType: 'opencode', state: 'waiting', receivedAt: Date.now() + 1 })]
        })
      ).toBe('blocked:agent-interactive-prompt')
      expect(
        await waitOutcome({
          ...options,
          rows: () => [row({ agentType: 'opencode', receivedAt: Date.now() + 1 })]
        })
      ).toBe('ready')
    })
  })
})

describe('Recovered Hermes screen input ordering', () => {
  const captured = readFileSync(
    join(__dirname, '../../__fixtures__', 'hermes-tui-ready.txt'),
    'utf8'
  )
  it.each(['recovery-first', 'reflow-first'] as const)(
    'orders screen validity with %s before allowing wait and mail',
    async (order) => {
      const size = { cols: 120, rows: 31 }
      const writes: string[] = []
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: 'Hermes Agent',
        foregroundProcess: 'hermes',
        launchAgent: 'hermes',
        size,
        data: captured,
        onWrite: (data) => writes.push(data),
        writeWithSettlement: settledWriteStub((_id, data) => {
          writes.push(data)
        })
      })
      await runtime.serializeMainTerminalBuffer(TRANSCRIPT_PANE_PTY_ID)
      writes.length = 0
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      const run = db.createRun({
        objective: 'reflow readiness',
        coordinatorHandle: handle,
        coordinatorPaneKey: makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
      })
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const originalWrite = HeadlessEmulator.prototype.write
      const heldWrite = vi
        .spyOn(HeadlessEmulator.prototype, 'write')
        .mockImplementationOnce(async function (this: HeadlessEmulator, data, options) {
          entered.resolve()
          await release.promise
          await originalWrite.call(this, data, options)
        })
      try {
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, '\x1b[0m', Date.now())
        await entered.promise
        const recover = (rows: number) =>
          runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(TRANSCRIPT_PANE_PTY_ID, {
            data: captured,
            cols: 120,
            rows,
            seq: runtime.getPtyOutputSequence(TRANSCRIPT_PANE_PTY_ID)
          })
        if (order === 'recovery-first') {
          recover(31)
          size.rows = 40
          runtime.reflowHeadlessTerminalToPtyGrid(TRANSCRIPT_PANE_PTY_ID, 120, 40)
        } else {
          size.rows = 40
          runtime.reflowHeadlessTerminalToPtyGrid(TRANSCRIPT_PANE_PTY_ID, 120, 40)
          recover(40)
        }
        vi.useFakeTimers({
          toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
        })
        const settled = vi.fn()
        const wait = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
        wait.then(settled, () => {})
        const message = db.insertMessage({
          from: 'term_worker',
          to: `run:${run.id}`,
          runId: run.id,
          type: 'worker_done',
          subject: 'Current screen only'
        })
        runtime.notifyMessageArrived(`run:${run.id}`, 'worker_done')
        release.resolve()
        await vi.advanceTimersByTimeAsync(6_000)
        if (order === 'recovery-first') {
          expect(settled).not.toHaveBeenCalled()
          expect(db.getMessageById(message.id)?.delivered_at).toBeNull()
          expect(
            writes.filter((data) => data.includes('orchestration message') || data === '\r')
          ).toEqual([])
          size.rows = 39
          runtime.resizeHeadlessTerminalToPtyGrid(TRANSCRIPT_PANE_PTY_ID, 120, 39)
          runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, captured, Date.now())
          await vi.advanceTimersByTimeAsync(5_000)
        }
        await expect(wait).resolves.toMatchObject({ satisfied: true })
        expect(settled).toHaveBeenCalledTimes(1)
        expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
        expect(
          writes.filter((data) => data.includes('orchestration message') || data === '\r')
        ).toEqual([expect.stringContaining('You have 1 orchestration message'), '\r'])
      } finally {
        release.resolve()
        heldWrite.mockRestore()
        vi.useRealTimers()
        db.close()
      }
    }
  )
})
