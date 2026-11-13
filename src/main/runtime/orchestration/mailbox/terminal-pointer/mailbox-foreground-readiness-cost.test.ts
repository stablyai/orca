import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { readRuntimeFixture } from '../../../terminal/wait/agent-transcript-replay-test-harness'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PANE_KEY,
  PTY_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { countForegroundSqlWork } from './mailbox-foreground-work.test-fixture'

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

it.each([
  { m: 2, status: null },
  { m: 20, status: null },
  { m: 2, status: 'permission' },
  { m: 20, status: 'permission' }
])(
  'bounds blocked-flight readiness with $status independently of $m owed mailboxes',
  async ({ m, status }) => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mail-screen-cost-')
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
    const composer = `\x1b[2J\x1b[H${readRuntimeFixture('claude-2-1-316-default-unlabelled-empty').replaceAll('\x1b]0;✳ Claude Code\x07', '')}`
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
      runtime.onPtyData(PTY_ID, `\x1b]0;✳ Claude Code\x07${composer}`, Date.now())
      runtime.onPtyData(PTY_ID, '\x1b]0;workspace shell\x07', Date.now())
      const otherMessages: string[] = []
      for (let i = 1; i < m; i++) {
        const other = createBoundRun(db, 'Other owed mailbox')
        otherMessages.push(
          db.insertMessage({
            from: 'term_sender',
            to: `run:${other.id}`,
            runId: other.id,
            subject: 'Owed during dialog',
            type: 'status',
            deliveryContract: 'current_delivery'
          }).id
        )
      }
      const run = createBoundRun(db, 'Deferred Enter cost')
      const message = insertDirectRunMessage(db, run.id, 'Staged mail')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
      expect(write).not.toHaveBeenCalled()
      shell = false
      write.mockImplementation((_ptyId, data) => {
        if (data !== '\r') {
          runtime.onPtyData(
            PTY_ID,
            '\x1b[2J\x1b[HDo you want to create hello.txt?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend',
            Date.now()
          )
        }
        return true
      })
      await vi.advanceTimersByTimeAsync(65000)
      expect(runtime.mailTerminal?.lastAgentStatus).toBeNull()
      expect(write).toHaveBeenCalledTimes(1)
      expect(db.getMessageById(message.id)).toMatchObject({
        read: 0,
        delivered_at: null,
        pointer_enter_pending: 2
      })
      if (status) {
        runtime.onPtyData(PTY_ID, '\x1b]0;Claude permission\x07', Date.now())
        await vi.advanceTimersByTimeAsync(0)
      }
      const attempts = vi.spyOn(runtime, 'deliverPendingMessagesForPty')
      const screens = vi.spyOn(runtime.idleEvidenceSource, 'readScreenLines')
      const work = countForegroundSqlWork(db)
      const priorInspections = inspections
      await vi.advanceTimersByTimeAsync(60000)
      const count = attempts.mock.calls.length
      // The blocked recovery keeps its wake throughout the minute, including retained permission.
      expect(count).toBeGreaterThanOrEqual(60000 / 2000 - 1)
      // One terminal decision every two seconds, plus the scheduling edge.
      expect(count).toBeLessThanOrEqual(60000 / 2000 + 1)
      expect(screens.mock.calls.length).toBeLessThanOrEqual(count)
      expect(inspections - priorInspections).toBe(0)
      // One reservation and its owner at wake and rearm; no mailbox inventory per attempt.
      expect(work.counts.statements).toBeLessThanOrEqual(4 * (count + 1))
      expect(work.counts.owners).toBeLessThanOrEqual(2 * (count + 1))
      expect(work.counts.messages).toBeLessThanOrEqual(2 * (count + 1))
      expect(write).toHaveBeenCalledTimes(1)
      console.info(
        'blocked-flight contract',
        JSON.stringify({
          m,
          status,
          attempts: count,
          screens: screens.mock.calls.length,
          inspections: inspections - priorInspections,
          sql: work.counts
        })
      )
      work.stop()
      // Consume the other obligations before readiness to isolate this flight's single Enter.
      db.markAsReadAndDelivered(otherMessages)
      runtime.onPtyData(PTY_ID, composer, Date.now())
      await vi.advanceTimersByTimeAsync(10000)
      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      expect(db.getMessageById(message.id)).toMatchObject({
        read: 0,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
      expect(row.state).toBe('done')
      await vi.advanceTimersByTimeAsync(65000)
      expect(write).toHaveBeenCalledTimes(2)
      write.mockImplementation(() => true)
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
      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r',
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      expect(db.getMessageById(later.id)).toMatchObject({
        read: 0,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
    } finally {
      db.close()
    }
  }
)
