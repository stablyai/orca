import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  readRuntimeFixture,
  readTimedRuntimeFixture
} from '../../../terminal/wait/agent-transcript-replay-test-harness'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PTY_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { countForegroundSqlWork } from './mailbox-foreground-work.test-fixture'
import type { WriteSettlement } from '../../../../../shared/terminal/pty/lifecycle/pty-write-settlement'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const READY = `\x1b[2J\x1b[H${readRuntimeFixture('claude-2-1-316-default-unlabelled-empty')}`
const DIALOG =
  '\x1b[2J\x1b[HDo you want to create hello.txt?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel · Tab to amend'
function composer(text: string) {
  return `\x1b[2J\x1b[H${'─'.repeat(100)}\r\n❯ ${text.trim()}\r\n${'─'.repeat(100)}\r\n  auto mode on\x1b[2;3H`
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('one mailbox submission owner', () => {
  it.each([
    'refused',
    'manual Enter',
    'deleted',
    'consumed',
    'unverifiable',
    'throw after handoff',
    'late acknowledgement'
  ])(
    'revalidates an ordinary flight that becomes recovery across delayed checks (%s)',
    async (intervention) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-mail-late-recovery-')
      const { runtime, write } = createRuntime(db, { launchAgent: 'claude' })
      let process = 'claude'
      let staged = ''
      let releaseAbsence!: (live: boolean) => void
      const absence = new Promise<boolean>((resolve) => {
        releaseAbsence = resolve
      })
      let delayAbsence = false
      let refuse = intervention === 'refused'
      let finishWrite!: (settlement: WriteSettlement) => void
      const acknowledgement = new Promise<WriteSettlement>((resolve) => {
        finishWrite = resolve
      })
      runtime.setPtyController({
        write,
        writeWithSettlement: (ptyId, data) => {
          write(ptyId, data)
          if (data === '\r' && intervention === 'late acknowledgement') {
            return acknowledgement
          }
          if (data === '\r' && refuse) {
            refuse = false
            runtime.onPtyData(PTY_ID, DIALOG, Date.now())
            return { outcome: 'refused', reason: 'provider_refused_write' }
          }
          if (data === '\r' && intervention === 'throw after handoff') {
            return Promise.reject(new Error('lost write acknowledgement'))
          }
          return data === '\r' && intervention === 'unverifiable'
            ? {
                outcome: 'unverifiable',
                reason: 'transport_settlement_lost',
                bytesHandedToTransport: true
              }
            : { outcome: 'accepted' }
        },
        kill: vi.fn(),
        getSize: () => ({ cols: 100, rows: 30 }),
        probePtyLiveness: () => (delayAbsence ? absence : Promise.resolve(true)),
        getForegroundProcess: async () => process,
        supportsForegroundObservation: () => true,
        inspectProcess: async () => ({
          foregroundProcess: process,
          hasChildProcesses: process !== 'zsh',
          foregroundObservation: {
            ptyId: PTY_ID,
            ptyIncarnationId: 'mailbox-incarnation',
            authorityGeneration: 'test',
            observationEpoch: 1,
            capturedAgeMs: 0,
            verdict: 'observed',
            source: 'pty-master',
            foregroundKind: process === 'zsh' ? 'shell' : 'non-shell',
            processName: process
          }
        })
      })
      try {
        await runtime.listTerminals()
        runtime.onPtyData(PTY_ID, READY, Date.now())
        const run = createBoundRun(db, 'Late recovery')
        const message = insertDirectRunMessage(db, run.id, 'One staged obligation')
        write.mockImplementation((_ptyId, data) => {
          if (data !== '\r') {
            staged = data
            delayAbsence = true
            runtime.onPtyData(PTY_ID, composer(staged), Date.now())
          }
          return true
        })
        runtime.notifyMessageArrived(`run:${run.id}`, 'status')
        await vi.advanceTimersByTimeAsync(1000)
        expect(write).toHaveBeenCalledTimes(1)
        expect(staged).toContain('You have 1 orchestration message')
        if (intervention !== 'late acknowledgement') {
          process = 'zsh'
          expect(await runtime.readTerminalMailHold(`run:${run.id}`)).toMatchObject({
            kind: 'not-foreground'
          })
        }
        if (intervention === 'manual Enter' || intervention === 'deleted') {
          runtime.onPtyData(PTY_ID, `${READY}\x1b]0;Claude working\x07`, Date.now())
        }
        if (intervention === 'consumed') {
          db.markAsRead([message.id])
        }
        // Quiescence must not mask the ownership transition while absence is unresolved.
        await vi.advanceTimersByTimeAsync(2500)
        process = 'claude'
        delayAbsence = false
        releaseAbsence(true)
        await vi.advanceTimersByTimeAsync(1000)
        if (intervention === 'late acknowledgement') {
          expect(write.mock.calls.map(([, data]) => data)).toEqual([staged, '\r'])
          process = 'zsh'
          expect(await runtime.readTerminalMailHold(`run:${run.id}`)).toMatchObject({
            kind: 'not-foreground'
          })
          process = 'claude'
          finishWrite({
            outcome: 'unverifiable',
            reason: 'transport_settlement_lost',
            bytesHandedToTransport: true
          })
          await vi.advanceTimersByTimeAsync(1000)
        }
        if (
          ['unverifiable', 'throw after handoff', 'late acknowledgement'].includes(intervention)
        ) {
          expect(write.mock.calls.map(([, data]) => data)).toEqual([staged, '\r'])
          expect(db.getMessageById(message.id)).toMatchObject({
            read: 0,
            delivered_at: null,
            pointer_enter_pending: 3
          })
          await vi.advanceTimersByTimeAsync(125000)
          expect(write).toHaveBeenCalledTimes(2)
          runtime.onPtyData(PTY_ID, READY, Date.now())
          await vi.advanceTimersByTimeAsync(65000)
          expect(write).toHaveBeenCalledTimes(2)
          expect(db.getMessageById(message.id)).toMatchObject({
            read: 0,
            delivered_at: null,
            pointer_enter_pending: 3
          })
          db.markAsReadAndDelivered([message.id])
          await vi.advanceTimersByTimeAsync(125000)
          expect(write).toHaveBeenCalledTimes(2)
          const attempts = vi.spyOn(runtime, 'deliverPendingMessagesForPty')
          await vi.advanceTimersByTimeAsync(65000)
          expect(attempts).not.toHaveBeenCalled()
          return
        }
        if (intervention === 'consumed') {
          expect(write.mock.calls.map(([, data]) => data)).toEqual([staged, '\r'])
          expect(db.getMessageById(message.id)).toMatchObject({ read: 1, pointer_enter_pending: 0 })
          await vi.advanceTimersByTimeAsync(65000)
          expect(write).toHaveBeenCalledTimes(2)
          return
        }
        expect(db.getMessageById(message.id)).toMatchObject({
          read: 0,
          delivered_at: null,
          pointer_enter_pending: 2
        })
        if (intervention === 'refused') {
          expect(write.mock.calls.map(([, data]) => data)).toEqual([staged, '\r'])
          runtime.onPtyData(PTY_ID, DIALOG, Date.now())
        } else {
          expect(write).toHaveBeenCalledTimes(1)
          runtime.onPtyData(PTY_ID, READY, Date.now())
        }
        await vi.advanceTimersByTimeAsync(125000)
        expect(write).toHaveBeenCalledTimes(intervention === 'refused' ? 2 : 1)
        expect(db.getMessageById(message.id)).toMatchObject({
          read: 0,
          delivered_at: null,
          pointer_enter_pending: 2
        })
        if (intervention === 'refused') {
          runtime.onPtyData(PTY_ID, composer(staged), Date.now())
          await vi.advanceTimersByTimeAsync(65000)
          expect(write.mock.calls.map(([, data]) => data)).toEqual([staged, '\r', '\r'])
          expect(db.getMessageById(message.id)).toMatchObject({
            read: 0,
            delivered_at: expect.any(String),
            pointer_enter_pending: 0
          })
        } else {
          db.markAsReadAndDelivered([message.id])
          await vi.advanceTimersByTimeAsync(65000)
          expect(write).toHaveBeenCalledTimes(1)
        }
        const attempts = vi.spyOn(runtime, 'deliverPendingMessagesForPty')
        await vi.advanceTimersByTimeAsync(65000)
        expect(attempts).not.toHaveBeenCalled()
      } finally {
        releaseAbsence(true)
        finishWrite({ outcome: 'accepted' })
        db.close()
      }
    }
  )

  it.each(['claude', 'codex', 'opencode2'] as const)(
    'recognises agent-rendered wrapped pointer rows in %s without accepting edits or dialogs',
    async (agent) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-mail-wrapped-pointer-')
      const { runtime, write } = createRuntime(db, { launchAgent: agent })
      let cols = agent === 'codex' ? 120 : agent === 'claude' ? 100 : 40
      const rows = agent === 'claude' ? 30 : 40
      const timed = readTimedRuntimeFixture('opencode-2-0-21-timed-narrow-pane')
      const ready =
        agent === 'claude'
          ? readRuntimeFixture('claude-2-1-316-labelled-empty')
          : agent === 'codex'
            ? readRuntimeFixture('codex-0157-plain-ready')
            : timed.chunks.filter((_, i) => timed.times[i] < timed.promptSentAtMs! - 600).join('')
      let shell = true
      let staged = ''
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getSize: () => ({ cols, rows }),
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
      // Recorded empty frames above; pointer contents and hard-row redraws below are synthetic.
      const wrapped = (text: string) => {
        const parts = text.trim().match(/.{1,28}/g) ?? ['']
        if (agent === 'opencode2') {
          return `\x1b[2J\x1b[HOpenCode\r\n   ┃\r\n${parts.map((part) => `   ┃  ${part}`).join('\r\n')}\r\n   ┃\r\n   ┃  Build · gpt-6.1\r\n   ╹▀▀▀▀▀▀▀▀\x1b[3;7H\x1b[?25h`
        }
        if (agent === 'codex') {
          return `\x1b[2J\x1b[HOpenAI Codex\r\n${'─'.repeat(40)}\r\n\x1b[1m›\x1b[0m ${parts.join('\r\n  ')}\r\n\r\n\x1b[2mgpt-6.1 · ~/repo\r\n? for shortcuts\x1b[0m\x1b[3;3H\x1b[?25h`
        }
        return `\x1b[2J\x1b[H${'─'.repeat(28)} ultracode ─\r\n❯ ${parts.join('\r\n  ')}\r\n${'─'.repeat(40)}\r\n  bypass permissions on\x1b[2;3H\x1b[?25h`
      }
      try {
        await runtime.listTerminals()
        runtime.onPtyData(PTY_ID, ready, Date.now())
        // Give the recorded frame its normal explicit rest marker, independent of custom labels.
        runtime.onPtyData(PTY_ID, `\x1b]0;${agent} done\x07`, Date.now())
        const run = createBoundRun(db, 'Agent wrapped pointer')
        const message = insertDirectRunMessage(db, run.id, 'One owned composer')
        runtime.notifyMessageArrived(`run:${run.id}`, 'status')
        await vi.advanceTimersByTimeAsync(1000)
        expect(write).not.toHaveBeenCalled()
        shell = false
        write.mockImplementation((_ptyId, data) => {
          if (data !== '\r') {
            staged = data
            runtime.onPtyData(PTY_ID, wrapped(`${data.trim()} edited`), Date.now())
          }
          return true
        })
        await vi.advanceTimersByTimeAsync(65000)
        expect(write).toHaveBeenCalledTimes(1)
        expect(db.getMessageById(message.id)).toMatchObject({
          read: 0,
          delivered_at: null,
          pointer_enter_pending: 2
        })
        await vi.advanceTimersByTimeAsync(65000)
        expect(write).toHaveBeenCalledTimes(1)
        if (agent !== 'opencode2') {
          cols = agent === 'claude' ? 40 : 120
          runtime.resizeHeadlessTerminalToPtyGrid(PTY_ID, cols, rows)
          runtime.onPtyData(
            PTY_ID,
            `\x1b[2J\x1b[H${readRuntimeFixture(
              agent === 'claude'
                ? 'claude-2-1-316-labelled-wrapped'
                : 'codex-fullscreen-multiline-early-input'
            )}`,
            Date.now()
          )
          await vi.advanceTimersByTimeAsync(65000)
          expect(write).toHaveBeenCalledTimes(1)
        }
        runtime.onPtyData(PTY_ID, DIALOG, Date.now())
        await vi.advanceTimersByTimeAsync(65000)
        expect(write).toHaveBeenCalledTimes(1)
        runtime.onPtyData(PTY_ID, wrapped(staged), Date.now())
        await vi.advanceTimersByTimeAsync(65000)
        expect(write.mock.calls.map(([, data]) => data)).toEqual([staged, '\r'])
        expect(db.getMessageById(message.id)).toMatchObject({
          read: 0,
          delivered_at: expect.any(String),
          pointer_enter_pending: 0
        })
        await vi.advanceTimersByTimeAsync(65000)
        expect(write).toHaveBeenCalledTimes(2)
      } finally {
        db.close()
      }
    }
  )

  it.each([
    { chunks: 12, m: 2, replay: false },
    { chunks: 120, m: 20, replay: false },
    { chunks: 12, m: 2, replay: true },
    { chunks: 120, m: 20, replay: true }
  ])(
    'keeps an owed wake under separate-turn output ($chunks chunks/s, $m mailboxes, replay=$replay)',
    async ({ chunks, m, replay }) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-mail-replay-cost-')
      const { runtime, write } = createRuntime(db, { launchAgent: 'claude' })
      let shell = true
      let inspections = 0
      let unknown = false
      let staged = ''
      let hydrate = false
      let coveredThrough = 0
      let sequence = 0
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getSize: () => ({ cols: 100, rows: 30 }),
        hasRendererSerializer: () => hydrate,
        serializeBuffer: async () => ({
          data: composer(staged),
          cols: 100,
          rows: 30,
          seq: coveredThrough
        }),
        getForegroundProcess: async () => null,
        supportsForegroundObservation: () => true,
        inspectProcess: async () => {
          inspections++
          if (unknown) {
            return { foregroundProcess: null, hasChildProcesses: false }
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
        sequence = runtime.onPtyData(PTY_ID, READY, Date.now())
        const messages: string[] = []
        for (let i = 0; i < m; i++) {
          const run = createBoundRun(db, 'Streaming recovery')
          messages.push(insertDirectRunMessage(db, run.id, 'Owed').id)
          runtime.notifyMessageArrived(`run:${run.id}`, 'status')
        }
        await vi.advanceTimersByTimeAsync(1000)
        expect(write).not.toHaveBeenCalled()
        shell = false
        write.mockImplementation((_ptyId, data) => {
          if (data !== '\r') {
            staged = data
            sequence = runtime.onPtyData(PTY_ID, composer(data), Date.now())
            unknown = true
          }
          return true
        })
        await vi.advanceTimersByTimeAsync(6000)
        expect(write).toHaveBeenCalledTimes(1)
        if (replay) {
          hydrate = true
          coveredThrough = sequence + chunks * '\x1b[0m\x1b[?25h'.length + 60 * '\x1b[0m'.length
          runtime.notePtyDataGap(PTY_ID)
          await runtime.maybeHydrateHeadlessFromRenderer(PTY_ID)
          await vi.advanceTimersByTimeAsync(0)
        }
        const work = countForegroundSqlWork(db)
        const attempts = vi.spyOn(runtime, 'deliverPendingMessagesForPty')
        const before = inspections
        // Every chunk arrives in a different turn; no title/status/hook observation is injected.
        for (let i = 0; i < chunks; i++) {
          runtime.onPtyData(PTY_ID, '\x1b[0m\x1b[?25h', Date.now())
          await vi.advanceTimersByTimeAsync(1000 / chunks)
        }
        expect(work.counts).toEqual({ statements: 0, owners: 0, messages: 0 })
        expect(inspections).toBe(before)
        expect(attempts).not.toHaveBeenCalled()
        work.stop()
        // Steady traffic must not cancel the owed deadline or cause a catch-up burst.
        for (let second = 0; second < 60; second++) {
          runtime.onPtyData(PTY_ID, '\x1b[0m', Date.now())
          await vi.advanceTimersByTimeAsync(1000)
        }
        expect(attempts.mock.calls.length).toBeGreaterThanOrEqual(2)
        expect(attempts.mock.calls.length).toBeLessThanOrEqual(4)
        expect(inspections - before).toBeLessThanOrEqual(4)
        unknown = false
        write.mockImplementation((_ptyId, data) => {
          runtime.onPtyData(PTY_ID, data === '\r' ? READY : composer(data), Date.now())
          return true
        })
        runtime.onPtyData(PTY_ID, composer(staged), Date.now())
        await vi.advanceTimersByTimeAsync(62000 + 2500 * m)
        expect(write.mock.calls.filter(([, text]) => text === '\r')).toHaveLength(m)
        for (const id of messages) {
          expect(db.getMessageById(id)).toMatchObject({
            read: 0,
            delivered_at: expect.any(String),
            pointer_enter_pending: 0
          })
        }
      } finally {
        db.close()
      }
    }
  )
})
