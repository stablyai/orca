import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { readRuntimeFixture } from '../../../terminal/wait/agent-transcript-replay-test-harness'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'
import { ORCHESTRATION_CHECK_METHODS } from '../../../rpc/methods/orchestration/messaging/check-methods'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PANE_KEY,
  PTY_ID,
  TERMINAL_HANDLE,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it.each(['consumed', 'still-owed'] as const)(
  'retires only settled recovery after a held check: %s',
  async (ending) => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mail-consumed-recovery-')
    const row: AgentStatusIpcPayload = {
      paneKey: PANE_KEY,
      connectionId: null,
      agentType: 'claude',
      state: 'done',
      prompt: '',
      receivedAt: Date.now(),
      stateStartedAt: 1
    }
    const { runtime, write } = createRuntime(db, {
      launchAgent: null,
      getAgentStatusSnapshot: () => [row],
      getAgentStatusSnapshotForPane: () => [row]
    })
    let shell = true
    let inspections = 0
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getSize: () => ({ cols: 100, rows: 30 }),
      getForegroundProcess: async () => null,
      supportsForegroundObservation: () => true,
      inspectProcess: async () => {
        inspections++
        return {
          foregroundProcess: shell ? 'zsh' : 'claude',
          hasChildProcesses: !shell,
          foregroundObservation: {
            ptyId: PTY_ID,
            ptyIncarnationId: 'mailbox-incarnation',
            authorityGeneration: 'test',
            observationEpoch: 1,
            capturedAgeMs: 0,
            verdict: 'observed',
            source: 'pty-master',
            foregroundKind: shell ? 'shell' : 'non-shell',
            processName: shell ? 'zsh' : 'claude'
          }
        }
      }
    })
    try {
      await runtime.listTerminals()
      const composer = `\x1b[2J\x1b[H${readRuntimeFixture('claude-2-1-316-default-unlabelled-empty').replaceAll('\x1b]0;✳ Claude Code\x07', '')}`
      runtime.onPtyData(PTY_ID, `\x1b]0;✳ Claude Code\x07${composer}`, Date.now())
      const run = createBoundRun(db, 'Consumed recovery episode')
      const message = insertDirectRunMessage(db, run.id, 'Read without a pointer')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(1000)
      expect(write).not.toHaveBeenCalled()
      const otherRun = ending === 'still-owed' ? createBoundRun(db, 'Still owed elsewhere') : null
      const remaining = otherRun
        ? db.insertMessage({
            from: 'term_worker',
            to: `run:${otherRun.id}`,
            runId: otherRun.id,
            subject: 'Not consumed by the other mailbox check',
            type: 'question',
            deliveryContract: 'current_delivery'
          })
        : null
      const check = ORCHESTRATION_CHECK_METHODS[0]!
      const result = await check.handler(
        check.params.parse({
          terminal: TERMINAL_HANDLE,
          run: run.id,
          types: 'status'
        }),
        { runtime }
      )
      expect(result).toMatchObject({ count: 1, messages: [{ id: message.id }] })
      expect(db.getMessageById(message.id)).toMatchObject({ read: 1, pointer_enter_pending: 0 })
      const before = inspections
      if (!remaining) {
        await vi.advanceTimersByTimeAsync(180000)
        expect(inspections).toBe(before)
      }
      shell = false
      row.state = 'working'
      row.receivedAt = Date.now()
      runtime.onPtyData(
        PTY_ID,
        '\x1b[2J\x1b[HWorking on the next task\r\n\x1b]0;Claude working\x07',
        Date.now()
      )
      const later = insertDirectRunMessage(db, run.id, 'Independent obligation')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(10000)
      if (remaining) {
        expect(write).not.toHaveBeenCalled()
        expect(db.getMessageById(remaining.id)).toMatchObject({ read: 0, delivered_at: null })
        expect(db.getMessageById(later.id)).toMatchObject({ read: 0, delivered_at: null })
        row.state = 'done'
        row.receivedAt = Date.now()
        write.mockImplementation((_ptyId, data) => {
          if (data !== '\r') {
            runtime.onPtyData(
              PTY_ID,
              `\x1b[2J\x1b[H${'─'.repeat(100)}\r\n❯ ${data.trim()}\r\n${'─'.repeat(100)}\r\n  auto mode on\x1b[2;3H`,
              Date.now()
            )
          } else {
            runtime.onPtyData(PTY_ID, composer, Date.now())
          }
          return true
        })
        runtime.onPtyData(PTY_ID, composer, Date.now())
        await vi.advanceTimersByTimeAsync(65000)
      }
      expect(write.mock.calls.map(([, data]) => data)).toEqual(
        remaining
          ? [
              expect.stringContaining('You have 1 orchestration message'),
              '\r',
              expect.stringContaining('You have 1 orchestration message'),
              '\r'
            ]
          : [expect.stringContaining('You have 1 orchestration message'), '\r']
      )
      expect(db.getMessageById(later.id)).toMatchObject({
        read: 0,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
      if (remaining) {
        expect(db.getMessageById(remaining.id)).toMatchObject({
          read: 0,
          delivered_at: expect.any(String),
          pointer_enter_pending: 0
        })
      }
      const settledInspections = inspections
      await vi.advanceTimersByTimeAsync(65000)
      expect(write).toHaveBeenCalledTimes(remaining ? 4 : 2)
      expect(inspections).toBe(settledInspections)
    } finally {
      db.close()
    }
  }
)
