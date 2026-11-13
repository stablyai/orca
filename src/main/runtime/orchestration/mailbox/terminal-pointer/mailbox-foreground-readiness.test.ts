import { readRuntimeFixture } from '../../../terminal/wait/agent-transcript-replay-test-harness'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDatabase,
  createRuntime,
  createBoundRun,
  insertDirectRunMessage,
  PTY_ID,
  PANE_KEY,
  TAB_ID,
  WORKTREE_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'

import { AgentHookServer } from '../../../../agent-hooks/server/agent-hook-server'
import {
  buildBody,
  postHookEvent,
  RUNNING_SHELL
} from '../../../../agent-hooks/server/testing/server.test-fixtures'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const COMPOSER = `\x1b[2J\x1b[H${readRuntimeFixture('claude-2-1-316-default-unlabelled-empty').replaceAll('\x1b]0;✳ Claude Code\x07', '')}`

describe('mail-local foreground recovery readiness', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    {
      veto: 'login',
      body: '\x1b[2J\x1b[HWelcome to Claude Code\r\nSelect login method:\r\n1. Claude account with subscription\r\n2. Anthropic Console account'
    },
    {
      veto: 'dialog',
      body: '\x1b[2J\x1b[HDo you want to create hello.txt?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend'
    },
    {
      veto: 'draft',
      body: `\x1b[2J\x1b[H${readRuntimeFixture('claude-2-1-316-default-unlabelled-middle').replaceAll('\x1b]0;✳ Claude Code\x07', '')}`
    },
    { veto: 'unhydrated', body: '' },
    { veto: 'restoring', body: '' },
    {
      veto: 'retained-idle dialog',
      body: '\x1b[2J\x1b[HDo you want to create hello.txt?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend',
      retainIdle: true,
      freshBlock: true
    },
    {
      veto: 'retained-idle expired dialog',
      body: '\x1b[2J\x1b[HDo you want to create hello.txt?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend',
      retainIdle: true
    },
    {
      veto: 'retained-idle expired login',
      body: '\x1b[2J\x1b[HWelcome to Claude Code\r\nSelect login method:\r\n1. Claude account with subscription\r\n2. Anthropic Console account',
      retainIdle: true
    }
  ])(
    'requires a current ready screen after expired identity, preserving the $veto veto',
    async ({
      veto,
      body,
      retainIdle = false,
      freshBlock = false
    }: {
      veto: string
      body: string
      retainIdle?: boolean
      freshBlock?: boolean
    }) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-mail-expired-readiness-')
      const row: AgentStatusIpcPayload = {
        paneKey: PANE_KEY,
        connectionId: null,
        agentType: 'claude' as const,
        state: 'done',
        prompt: '',
        receivedAt: Date.now(),
        stateStartedAt: 1
      }
      const originalRow = { ...row }
      const { runtime, write } = createRuntime(db, {
        launchAgent: null,
        getAgentStatusSnapshot: () => [row],
        getAgentStatusSnapshotForPane: () => [row]
      })
      let shell = true
      let unavailable = false
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getSize: () => ({ cols: 100, rows: 30 }),
        getForegroundProcess: async () => null,
        supportsForegroundObservation: () => true,
        inspectProcess: async () => {
          if (unavailable) {
            throw new Error('foreground inspection unavailable')
          }
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
        runtime.onPtyData(PTY_ID, `\x1b]0;✳ Claude Code\x07${COMPOSER}`, Date.now())
        await vi.advanceTimersByTimeAsync(1000)
        if (!retainIdle) {
          runtime.onPtyData(PTY_ID, '\x1b]0;workspace shell\x07', Date.now())
        }
        const run = createBoundRun(db, 'Current readiness after long hold')
        const message = insertDirectRunMessage(db, run.id, 'Wait for the composer')
        runtime.notifyMessageArrived(`run:${run.id}`, 'status')
        await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
        expect(write).not.toHaveBeenCalled()
        expect(runtime.mailTerminal?.lastAgentStatus).toBe(retainIdle ? 'idle' : null)
        if (freshBlock) {
          row.state = 'waiting'
          row.receivedAt = Date.now()
        }
        shell = false
        runtime.setMailScreenRestoring(veto === 'restoring')
        const unreadable =
          veto === 'unhydrated'
            ? vi.spyOn(runtime.idleEvidenceSource, 'readScreenLines').mockReturnValue(null)
            : null
        if (body) {
          runtime.onPtyData(PTY_ID, body, Date.now())
        }
        await vi.advanceTimersByTimeAsync(65000)
        expect(write).not.toHaveBeenCalled()
        expect(db.getMessageById(message.id)).toMatchObject({
          read: 0,
          delivered_at: null,
          pointer_enter_pending: 0
        })
        if (!freshBlock) {
          expect(row).toEqual(originalRow)
        }
        unreadable?.mockRestore()
        runtime.setMailScreenRestoring(false)
        runtime.onPtyData(PTY_ID, COMPOSER, Date.now())
        if (freshBlock) {
          row.state = 'done'
          unavailable = true
          await vi.advanceTimersByTimeAsync(65000)
          expect(write).not.toHaveBeenCalled()
          unavailable = false
        }
        await vi.advanceTimersByTimeAsync(65000)
        expect(write.mock.calls.map(([, data]) => data)).toEqual([
          expect.stringContaining('You have 1 orchestration message'),
          '\r'
        ])
        expect(db.getMessageById(message.id)).toMatchObject({
          read: 0,
          delivered_at: expect.any(String),
          pointer_enter_pending: 0
        })
        if (!freshBlock) {
          expect(row).toEqual(originalRow)
        }
        expect(runtime.mailTerminal?.lastAgentStatus).toBe(retainIdle ? 'idle' : null)
        await vi.advanceTimersByTimeAsync(65000)
        expect(write).toHaveBeenCalledTimes(2)
      } finally {
        db.close()
      }
    }
  )
  it.each([
    { kind: 'ordinary', recovering: false, receiptFirst: false },
    { kind: 'recovered', recovering: true, receiptFirst: false },
    { kind: 'receipt-first', recovering: true, receiptFirst: true },
    { kind: 'child-expiry', recovering: true, receiptFirst: false },
    { kind: 'owed-read-error', recovering: true, receiptFirst: false },
    { kind: 'waiter-masked', recovering: true, receiptFirst: false },
    { kind: 'reset', recovering: true, receiptFirst: false },
    { kind: 'fresh-in-band', recovering: true, receiptFirst: false },
    { kind: 'fresh-hook', recovering: true, receiptFirst: false },
    { kind: 'claude-lease', recovering: true, receiptFirst: false },
    { kind: 'permission-edge', recovering: false, receiptFirst: false }
  ])(
    'keeps a late dialog off the foreground retry schedule ($kind)',
    async ({ kind, recovering, receiptFirst }) => {
      const server = ['fresh-hook', 'claude-lease'].includes(kind) ? new AgentHookServer() : null
      vi.useFakeTimers(
        server
          ? {
              shouldAdvanceTime: true,
              toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']
            }
          : undefined
      )
      let detach: (() => void) | undefined
      const db = createDatabase('orca-mail-late-dialog-')
      const row: AgentStatusIpcPayload = {
        paneKey: PANE_KEY,
        connectionId: null,
        agentType: 'claude' as const,
        state: 'done',
        prompt: '',
        receivedAt: Date.now(),
        stateStartedAt: 1
      }
      const originalRow = { ...row }
      const { runtime, write } = createRuntime(db, {
        launchAgent: null,
        getAgentStatusSnapshot: () => [row],
        getAgentStatusSnapshotForPane: () => [row]
      })
      let shell = recovering
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
        runtime.onPtyData(PTY_ID, `\x1b]0;✳ Claude Code\x07${COMPOSER}`, Date.now())
        await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
        if (kind === 'child-expiry') {
          runtime.onPtyData(
            PTY_ID,
            '\x1b]7501;state=working:app=claude-code\x07\x1b]7501;state=working:id=child\x07\x1b]7501;state=done:app=claude-code\x07\x1b]0;✳ Claude Code\x07',
            Date.now()
          )
        }
        const run = createBoundRun(db, 'Dialog after pointer write')
        const message = insertDirectRunMessage(db, run.id, 'Wait before Enter')
        write.mockImplementation((_ptyId, data) => {
          if (data !== '\r') {
            if (!recovering) {
              row.state = 'waiting'
              row.receivedAt = Date.now()
            }
            if (kind === 'permission-edge') {
              runtime.onPtyData(PTY_ID, '\x1b]0;Claude permission\x07', Date.now())
            }
            runtime.onPtyData(
              PTY_ID,
              '\x1b[2J\x1b[HDo you want to create hello.txt?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend',
              Date.now()
            )
          }
          return true
        })
        runtime.notifyMessageArrived(`run:${run.id}`, 'status')
        await vi.advanceTimersByTimeAsync(1000)
        if (recovering) {
          expect(write).not.toHaveBeenCalled()
          shell = false
          const receipt = receiptFirst ? runtime.readTerminalMailHold(`run:${run.id}`) : null
          if (receiptFirst) {
            runtime.notifyMessageArrived(`run:${run.id}`, 'status')
          }
          await vi.advanceTimersByTimeAsync(65000)
          if (receipt) {
            expect(await receipt).toBeNull()
          }
        }
        expect(write.mock.calls.map(([, data]) => data)).toEqual([
          expect.stringContaining('You have 1 orchestration message')
        ])
        expect(db.getMessageById(message.id)).toMatchObject({
          read: 0,
          delivered_at: null,
          pointer_enter_pending: 2
        })
        if (kind === 'reset' || kind === 'fresh-in-band') {
          runtime.onPtyData(
            PTY_ID,
            kind === 'reset'
              ? '\x1b]7501;state=working:app=claude-code\x07\x1bc\x1b]0;✳ Claude Code\x07\x1b[2J\x1b[HDo you want to create hello.txt?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend'
              : '\x1b]7501;state=idle:app=claude-code\x07',
            Date.now()
          )
          await vi.advanceTimersByTimeAsync(1000)
          expect(write).toHaveBeenCalledTimes(1)
        }
        if (server) {
          const directory = mkdtempSync(join(tmpdir(), 'orca-mail-hook-recovery-'))
          temporaryDirectories.push(directory)
          await server.start({ env: 'production', userDataPath: directory })
          detach = runtime.attachAgentStatusStore(server)
          const post = async (payload: Record<string, unknown>) => {
            const response = await postHookEvent(
              server,
              buildBody(
                { session_id: 'mail-recovery-session', ...payload },
                { paneKey: PANE_KEY, tabId: TAB_ID, worktreeId: WORKTREE_ID }
              )
            )
            expect(response.status).toBe(204)
          }
          await post({ hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' })
          if (kind === 'claude-lease') {
            await post({
              hook_event_name: 'PostToolUse',
              tool_name: 'Bash',
              tool_response: { backgroundTaskId: RUNNING_SHELL.id }
            })
            await post({ hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
            await post({ hook_event_name: 'UserPromptSubmit', prompt: 'thanks' })
          }
          await post({ hook_event_name: 'Stop', background_tasks: [] })
          expect(server.getStatusSnapshotForPane(PANE_KEY)[0]?.state).toBe(
            kind === 'claude-lease' ? 'working' : 'done'
          )
          if (kind === 'claude-lease') {
            expect(write).toHaveBeenCalledTimes(1)
          }
          await vi.advanceTimersByTimeAsync(65000)
          expect(server.getStatusSnapshotForPane(PANE_KEY)[0]?.state).toBe('done')
          expect(write).toHaveBeenCalledTimes(1)
        }
        if (kind === 'waiter-masked') {
          const waiter = new AbortController()
          const waiting = runtime.waitForMessage(`run:${run.id}`, { signal: waiter.signal })
          await runtime.readTerminalMailHold(`run:${run.id}`)
          await vi.advanceTimersByTimeAsync(0)
          waiter.abort()
          expect(await waiting).toBe('cancelled')
          runtime.requestMailDecision(PTY_ID)
        }
        if (kind === 'owed-read-error') {
          const read = vi.spyOn(db, 'getMessageById').mockImplementationOnce(() => {
            throw new Error('temporarily unavailable')
          })
          await runtime.readTerminalMailHold(`run:${run.id}`)
          await vi.advanceTimersByTimeAsync(0)
          expect(read).toHaveBeenCalled()
          read.mockRestore()
        }
        const attempts = vi.spyOn(runtime, 'deliverPendingMessagesForPty')
        const deferredInspections = inspections
        await vi.advanceTimersByTimeAsync(kind === 'child-expiry' ? 21 * 60 * 1000 : 65000)
        if (kind === 'permission-edge') {
          expect(runtime.mailTerminal?.lastAgentStatus).toBe('permission')
          expect(attempts).not.toHaveBeenCalled()
        }
        expect(write).toHaveBeenCalledTimes(1)
        expect(inspections).toBe(deferredInspections)
        if (recovering) {
          expect(row).toEqual(originalRow)
          expect(runtime.mailTerminal?.lastAgentStatus).toBe('idle')
        } else {
          row.state = 'done'
          row.receivedAt = Date.now()
        }
        if (kind === 'permission-edge') {
          runtime.onPtyData(PTY_ID, '\x1b]0;✳ Claude Code\x07', Date.now())
        }
        runtime.onPtyData(PTY_ID, COMPOSER, Date.now())
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
        attempts.mockClear()
        const settledInspections = inspections
        await vi.advanceTimersByTimeAsync(65000)
        expect(write).toHaveBeenCalledTimes(2)
        expect(attempts).not.toHaveBeenCalled()
        expect(inspections).toBe(settledInspections)
      } finally {
        detach?.()
        server?.stop()
        db.close()
      }
    }
  )
})
