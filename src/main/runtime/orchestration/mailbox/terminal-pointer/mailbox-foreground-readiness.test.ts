import { readRuntimeFixture } from '../../../terminal/wait/agent-transcript-replay-test-harness'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDatabase,
  createRuntime,
  createBoundRun,
  insertDirectRunMessage,
  PTY_ID,
  PANE_KEY,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'

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
      retainIdle: true
    }
  ])(
    'requires a current ready screen after expired identity, preserving the $veto veto',
    async ({
      veto,
      body,
      retainIdle = false
    }: {
      veto: string
      body: string
      retainIdle?: boolean
    }) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-mail-expired-readiness-')
      const row = {
        paneKey: PANE_KEY,
        connectionId: null,
        agentType: 'claude' as const,
        state: 'done' as 'done' | 'waiting',
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
        runtime.onPtyData(PTY_ID, `\x1b]0;✳ Claude Code\x07${COMPOSER}`, 1)
        await vi.advanceTimersByTimeAsync(1000)
        if (!retainIdle) {
          runtime.onPtyData(PTY_ID, '\x1b]0;workspace shell\x07', 2)
        }
        const run = createBoundRun(db, 'Current readiness after long hold')
        const message = insertDirectRunMessage(db, run.id, 'Wait for the composer')
        runtime.notifyMessageArrived(`run:${run.id}`, 'status')
        await vi.advanceTimersByTimeAsync(31 * 60 * 1000)
        expect(write).not.toHaveBeenCalled()
        expect(runtime.mailTerminal?.lastAgentStatus).toBe(retainIdle ? 'idle' : null)
        if (retainIdle) {
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
          runtime.onPtyData(PTY_ID, body, 3)
        }
        await vi.advanceTimersByTimeAsync(65000)
        expect(write).not.toHaveBeenCalled()
        expect(db.getMessageById(message.id)).toMatchObject({
          read: 0,
          delivered_at: null,
          pointer_enter_pending: 0
        })
        if (!retainIdle) {
          expect(row).toEqual(originalRow)
        }
        unreadable?.mockRestore()
        runtime.setMailScreenRestoring(false)
        runtime.onPtyData(PTY_ID, COMPOSER, 4)
        if (retainIdle) {
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
        if (!retainIdle) {
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
})
