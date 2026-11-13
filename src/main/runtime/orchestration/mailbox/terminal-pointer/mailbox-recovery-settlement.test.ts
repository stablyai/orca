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

function recoveryTerminal(agent: 'claude' | 'codex' = 'claude') {
  const db = createDatabase('orca-mail-recovery-settlement-')
  const { runtime, write } = createRuntime(db, { launchAgent: agent })
  let shell = true
  const ready = `\x1b[2J\x1b[H${readRuntimeFixture(
    agent === 'claude' ? 'claude-2-1-316-default-unlabelled-empty' : 'codex-0157-plain-ready'
  ).replace(new RegExp(String.raw`\x1b\](?:0|2);[^\x07\x1b]*(?:\x07|\x1b\\)`, 'g'), '')}`
  const composer = (text: string) =>
    agent === 'codex'
      ? `\x1b[2J\x1b[HOpenAI Codex\r\n${'─'.repeat(100)}\r\n\x1b[1m›\x1b[0m ${text.trim()}\r\n\r\n\x1b[2mgpt-6.1 · ~/repo\r\n? for shortcuts\x1b[0m\x1b[3;3H\x1b[?25h`
      : `\x1b[2J\x1b[H${'─'.repeat(100)}\r\n❯ ${text.trim()}\r\n${'─'.repeat(100)}\r\n  auto mode on\x1b[2;3H`
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: vi.fn(),
    getSize: () => ({ cols: agent === 'codex' ? 120 : 100, rows: agent === 'codex' ? 40 : 30 }),
    getForegroundProcess: async () => null,
    supportsForegroundObservation: () => true,
    inspectProcess: async () => ({
      foregroundProcess: shell ? 'zsh' : agent,
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
        processName: shell ? 'zsh' : agent
      }
    })
  })
  write.mockImplementation((_ptyId, data) => {
    runtime.onPtyData(PTY_ID, data === '\r' ? ready : composer(data), Date.now())
    return true
  })
  return {
    db,
    runtime,
    write,
    ready,
    composer,
    returnAgent: () => {
      shell = false
    }
  }
}

it.each(['throw', 'unclaimed'] as const)(
  'retries known-unsent Enter after a one-shot reservation failure: %s',
  async (failure) => {
    vi.useFakeTimers()
    const { db, runtime, write, ready, returnAgent } = recoveryTerminal()
    try {
      await runtime.listTerminals()
      runtime.onPtyData(PTY_ID, `\x1b]0;Claude done\x07${ready}`, Date.now())
      const run = createBoundRun(db, 'Retry reservation preparation')
      const message = insertDirectRunMessage(db, run.id, 'Known unsent')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(1000)
      expect(write).not.toHaveBeenCalled()
      const claim = vi.spyOn(db, 'markMailboxPointerEnterAttempted')
      claim.mockImplementationOnce(() => {
        if (failure === 'throw') {
          throw new Error('transient reservation failure')
        }
        return false
      })
      returnAgent()
      await vi.advanceTimersByTimeAsync(6000)
      expect(claim).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledTimes(1)
      const pointer = write.mock.calls[0]![1]
      expect(db.getMessageById(message.id)).toMatchObject({
        read: 0,
        delivered_at: null,
        pointer_enter_pending: 2
      })
      await vi.advanceTimersByTimeAsync(65000)
      expect(write.mock.calls.map(([, data]) => data)).toEqual([pointer, '\r'])
      expect(db.getMessageById(message.id)).toMatchObject({
        read: 0,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
      await vi.advanceTimersByTimeAsync(130000)
      expect(write).toHaveBeenCalledTimes(2)
    } finally {
      db.close()
    }
  }
)

it.each([2, 20])(
  'drains %i recovered mailboxes under retained permission without another edge',
  async (m) => {
    vi.useFakeTimers()
    const { db, runtime, write, ready, composer, returnAgent } = recoveryTerminal('codex')
    try {
      await runtime.listTerminals()
      runtime.onPtyData(PTY_ID, `\x1b]0;Codex done\x07${ready}`, Date.now())
      const messages: string[] = []
      for (let i = 0; i < m; i++) {
        const run = createBoundRun(db, 'Serialized retained-permission recovery')
        messages.push(
          db.insertMessage({
            from: 'term_worker',
            to: `run:${run.id}`,
            runId: run.id,
            subject: 'Owed mailbox',
            type: 'status',
            deliveryContract: 'current_delivery'
          }).id
        )
        runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      }
      await vi.advanceTimersByTimeAsync(1000)
      expect(write).not.toHaveBeenCalled()
      let permissionObserved = false
      write.mockImplementation((_ptyId, data) => {
        const title = !permissionObserved && data !== '\r' ? '\x1b]0;Codex permission\x07' : ''
        if (data !== '\r') {
          permissionObserved = true
        }
        runtime.onPtyData(PTY_ID, `${title}${data === '\r' ? ready : composer(data)}`, Date.now())
        return true
      })
      returnAgent()
      // First wake plus staggering; each mailbox gets the normal three-second quiet and paste costs.
      await vi.advanceTimersByTimeAsync(6000 + 3600 * m)
      expect(runtime.mailTerminal?.lastAgentStatus).toBe('permission')
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(m)
      expect(
        new Set(write.mock.calls.filter(([, data]) => data !== '\r').map(([, data]) => data)).size
      ).toBe(m)
      expect(write).toHaveBeenCalledTimes(2 * m)
      for (const id of messages) {
        expect(db.getMessageById(id)).toMatchObject({
          read: 0,
          delivered_at: expect.any(String),
          pointer_enter_pending: 0
        })
      }
      const wakes = vi.spyOn(runtime, 'deliverPendingMessagesForPty')
      await vi.advanceTimersByTimeAsync(130000)
      expect(wakes).not.toHaveBeenCalled()
      expect(write).toHaveBeenCalledTimes(2 * m)
    } finally {
      db.close()
    }
  }
)

it.each(['same', 'other'] as const)(
  'lets new %s-mailbox mail pass a deleted recovery pointer without replaying it',
  async (mailbox) => {
    vi.useFakeTimers()
    const { db, runtime, write, ready, returnAgent } = recoveryTerminal()
    try {
      await runtime.listTerminals()
      runtime.onPtyData(PTY_ID, `\x1b]0;Claude done\x07${ready}`, Date.now())
      const run = createBoundRun(db, 'Deleted pointer uncertainty')
      const older = insertDirectRunMessage(db, run.id, 'Older unread mail')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(1000)
      returnAgent()
      write.mockImplementation((_ptyId, _data) => {
        runtime.onPtyData(PTY_ID, ready, Date.now())
        return true
      })
      await vi.advanceTimersByTimeAsync(6000)
      expect(write).toHaveBeenCalledTimes(1)
      const oldPointer = write.mock.calls[0]![1]
      const wakes = vi.spyOn(runtime, 'deliverPendingMessagesForPty')
      await vi.advanceTimersByTimeAsync(600000)
      expect(wakes.mock.calls.length).toBeLessThanOrEqual(13)
      expect(write).toHaveBeenCalledTimes(1)
      expect(db.getMessageById(older.id)).toMatchObject({
        read: 0,
        delivered_at: null,
        pointer_enter_pending: 2
      })
      const nextRun = mailbox === 'same' ? run : createBoundRun(db, 'New mailbox')
      const newer = insertDirectRunMessage(db, nextRun.id, 'New delivery obligation')
      let pointer = ''
      write.mockImplementation((_ptyId, data) => {
        if (data !== '\r') {
          pointer = data
          runtime.onPtyData(
            PTY_ID,
            `\x1b[2J\x1b[H${'─'.repeat(100)}\r\n❯ ${data.trim()}\r\n${'─'.repeat(100)}\r\n  auto mode on\x1b[2;3H`,
            Date.now()
          )
        }
        return true
      })
      runtime.notifyMessageArrived(`run:${nextRun.id}`, 'status')
      await vi.advanceTimersByTimeAsync(10000)
      expect(write.mock.calls.map(([, data]) => data)).toEqual([oldPointer, pointer, '\r'])
      expect(pointer).toContain(`--run ${nextRun.id}`)
      expect(pointer).toContain('You have 1 orchestration message')
      expect(db.getMessageById(older.id)).toMatchObject({
        read: 0,
        delivered_at: null,
        pointer_enter_pending: 2
      })
      expect(db.getMessageById(newer.id)).toMatchObject({
        read: 0,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
      wakes.mockClear()
      await vi.advanceTimersByTimeAsync(600000)
      expect(wakes.mock.calls.length).toBeLessThanOrEqual(13)
      expect(write).toHaveBeenCalledTimes(3)
      const check = ORCHESTRATION_CHECK_METHODS[0]!
      for (const currentRun of new Set([run, nextRun])) {
        const result = await check.handler(
          check.params.parse({ terminal: TERMINAL_HANDLE, run: currentRun.id }),
          { runtime }
        )
        expect(result).toMatchObject({ count: mailbox === 'same' ? 2 : 1 })
      }
      for (const id of [older.id, newer.id]) {
        expect(db.getMessageById(id)).toMatchObject({ read: 1, pointer_enter_pending: 0 })
      }
      wakes.mockClear()
      await vi.advanceTimersByTimeAsync(130000)
      expect(wakes).not.toHaveBeenCalled()
      expect(write).toHaveBeenCalledTimes(3)
    } finally {
      db.close()
    }
  }
)
