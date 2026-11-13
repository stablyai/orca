import { resolvePtyForegroundMembers } from '../../../../pty/process-retirement/pty-master-foreground-observation'
import { readRuntimeFixture } from '../../../terminal/wait/agent-transcript-replay-test-harness'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDatabase,
  createRuntime,
  createBoundRun,
  insertDirectRunMessage,
  driveToLiveIdle,
  PTY_ID,
  PANE_KEY,
  TERMINAL_HANDLE,
  TAB_ID,
  LEAF_ID,
  WORKTREE_ID,
  LAUNCH_TOKEN,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('owed mailbox foreground revalidation', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['posix', 'windows'] as const)(
    'keeps a proven shell held through unavailable %s reads, then recovers on affirmative evidence',
    async (host) => {
      vi.useFakeTimers()
      const platform = process.platform
      if (host === 'windows') {
        Object.defineProperty(process, 'platform', { value: 'win32' })
      }
      const db = createDatabase('orca-mail-unknown-')
      const { runtime } = createRuntime(db)
      const write = vi.fn((_ptyId: string, _data: string) => true)
      let mode: 'shell' | 'failed' | 'agent' = 'shell'
      let inspections = 0
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getForegroundProcess: async () => 'codex',
        confirmShellForeground: async () => {
          inspections++
          return mode === 'shell'
        },
        supportsForegroundObservation: () => true,
        inspectProcess: async () => {
          inspections++
          if (mode === 'failed') {
            throw new Error('inspection unavailable')
          }
          return {
            foregroundProcess: mode === 'shell' ? 'zsh' : 'codex',
            hasChildProcesses: mode !== 'shell',
            foregroundObservation: {
              ptyId: PTY_ID,
              ptyIncarnationId: 'mailbox-incarnation',
              authorityGeneration: 'test',
              observationEpoch: 1,
              capturedAgeMs: 0,
              verdict: 'observed',
              source: 'pty-master',
              foregroundKind: mode === 'shell' ? 'shell' : 'non-shell',
              processName: mode === 'shell' ? 'zsh' : 'codex'
            }
          }
        }
      })
      try {
        const run = createBoundRun(db, 'Unknown is not a return')
        await driveToLiveIdle(runtime)
        const message = insertDirectRunMessage(db, run.id, 'Waiting mail')
        runtime.notifyMessageArrived(`run:${run.id}`, 'status')
        await vi.advanceTimersByTimeAsync(1000)
        expect(write).not.toHaveBeenCalled()
        mode = 'failed'
        await vi.advanceTimersByTimeAsync(20000)
        expect(inspections).toBeGreaterThan(1)
        expect(write).not.toHaveBeenCalled()
        expect(db.getMessageById(message.id)).toMatchObject({ read: 0, delivered_at: null })
        expect(await runtime.readTerminalMailHold(`run:${run.id}`)).toMatchObject({
          kind: 'not-live'
        })
        if (host === 'windows') {
          Object.defineProperty(process, 'platform', { value: platform })
        }
        mode = 'agent'
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
        await vi.advanceTimersByTimeAsync(65000)
        expect(write).toHaveBeenCalledTimes(2)
      } finally {
        Object.defineProperty(process, 'platform', { value: platform })
        db.close()
      }
    }
  )

  it('converges delivery, receipt and Enter while compatible observations overlap slow inspections', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mail-convergence-')
    const { runtime } = createRuntime(db)
    const write = vi.fn((_ptyId: string, _data: string) => true)
    let inspections = 0
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => 'codex',
      supportsForegroundObservation: () => true,
      inspectProcess: async () => {
        inspections++
        await new Promise((resolve) => setTimeout(resolve, 200))
        return {
          foregroundProcess: 'codex',
          hasChildProcesses: true,
          foregroundObservation: {
            ptyId: PTY_ID,
            ptyIncarnationId: 'mailbox-incarnation',
            authorityGeneration: 'test',
            observationEpoch: 1,
            capturedAgeMs: 0,
            verdict: 'observed',
            source: 'pty-master',
            foregroundKind: 'non-shell',
            processName: 'codex'
          }
        }
      }
    })
    const run = createBoundRun(db, 'Converging delivery')
    await driveToLiveIdle(runtime)
    runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', 2)
    const message = insertDirectRunMessage(db, run.id, 'Converging mail')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    let receiptDone = false
    const receipt = runtime.readTerminalMailHold(`run:${run.id}`).then(() => {
      receiptDone = true
    })
    const spinner = setInterval(
      () => runtime.onPtyData(PTY_ID, '\x1b]0;Codex working\x07', Date.now()),
      50
    )
    try {
      await vi.advanceTimersByTimeAsync(1500)
      expect(receiptDone).toBe(true)
      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      expect(db.getMessageById(message.id)).toMatchObject({
        read: 0,
        delivered_at: expect.any(String),
        pointer_enter_pending: 0
      })
      expect(inspections).toBeLessThanOrEqual(3)
      await receipt
    } finally {
      clearInterval(spinner)
      db.close()
    }
  })

  it('requires current intended-agent evidence before a retained hook row revives null status', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-mail-hook-boundary-')
    const row = {
      paneKey: PANE_KEY,
      connectionId: null,
      agentType: 'claude' as const,
      state: 'done' as const,
      prompt: '',
      receivedAt: Date.now(),
      stateStartedAt: 1
    }
    const { runtime, write } = createRuntime(db, {
      launchAgent: null,
      getAgentStatusSnapshotForPane: () => [row],
      getAgentStatusSnapshot: () => [row]
    })
    let mode: 'shell' | 'unknown' | 'other' | 'agent' = 'shell'
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getSize: () => ({ cols: 100, rows: 30 }),
      getForegroundProcess: async () => null,
      supportsForegroundObservation: () => true,
      inspectProcess: async () => {
        if (mode === 'unknown') {
          throw new Error('unavailable')
        }
        const name = mode === 'shell' ? 'zsh' : mode === 'other' ? 'vim' : 'claude'
        return {
          foregroundProcess: name,
          hasChildProcesses: mode !== 'shell',
          foregroundObservation: {
            ptyId: PTY_ID,
            ptyIncarnationId: 'mailbox-incarnation',
            authorityGeneration: 'test',
            observationEpoch: 1,
            capturedAgeMs: 0,
            verdict: 'observed',
            source: 'pty-master',
            foregroundKind: mode === 'shell' ? 'shell' : 'non-shell',
            processName: name
          }
        }
      }
    })
    await runtime.listTerminals()
    runtime.onPtyData(PTY_ID, readRuntimeFixture('claude-2-1-316-default-unlabelled-empty'), 1)
    await vi.advanceTimersByTimeAsync(1000)
    const run = createBoundRun(db, 'Hook boundary')
    runtime.onPtyData(PTY_ID, '\x1b]0;workspace shell\x07', 2)
    await vi.advanceTimersByTimeAsync(1000)
    mode = 'unknown'
    const initial = insertDirectRunMessage(db, run.id, 'Retained hook alone cannot admit')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).not.toHaveBeenCalled()
    mode = 'other'
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).not.toHaveBeenCalled()
    mode = 'agent'
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1000)
    expect(db.getMessageById(initial.id)).toMatchObject({
      delivered_at: expect.any(String),
      pointer_enter_pending: 0
    })
    expect(write).toHaveBeenCalledTimes(2)
    write.mockClear()
    mode = 'shell'
    const message = insertDirectRunMessage(db, run.id, 'Retained hook is not execution proof')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1000)
    runtime.onPtyData(PTY_ID, '\x1b]0;workspace shell\x07', 3)
    await vi.advanceTimersByTimeAsync(1000)
    mode = 'unknown'
    await vi.advanceTimersByTimeAsync(20000)
    expect(write).not.toHaveBeenCalled()
    mode = 'other'
    await vi.advanceTimersByTimeAsync(65000)
    expect(write).not.toHaveBeenCalled()
    expect(db.getMessageById(message.id)).toMatchObject({ read: 0, delivered_at: null })
    mode = 'agent'
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
    db.close()

    // Older hosts with no earlier shell refusal retain their original compatibility path.
    const compatibilityDb = createDatabase('orca-mail-legacy-')
    const compatibility = createRuntime(compatibilityDb)
    const legacyRun = createBoundRun(compatibilityDb, 'Unknown host compatibility')
    await driveToLiveIdle(compatibility.runtime)
    insertDirectRunMessage(compatibilityDb, legacyRun.id, 'Ordinary unknown-host mail')
    compatibility.runtime.notifyMessageArrived(`run:${legacyRun.id}`, 'status')
    await vi.advanceTimersByTimeAsync(1000)
    expect(compatibility.write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    compatibilityDb.close()
  })

  it.each([
    { other: 'vim', command: '/usr/local/bin/codex-aarch64-apple-darwin' },
    { other: 'less', command: 'node /opt/node_modules/@openai/codex/bin/codex.js' },
    { other: 'node', command: '/usr/local/bin/codex' }
  ])(
    'keeps retained idle mail out of $other and resumes with $command',
    async ({ other, command }) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-mail-other-program-')
      const { runtime, write } = createRuntime(db)
      let name = 'zsh'
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getForegroundProcess: async () => null,
        supportsForegroundObservation: () => true,
        inspectProcess: async () => ({
          foregroundProcess: name,
          hasChildProcesses: name !== 'zsh',
          foregroundObservation: {
            ptyId: PTY_ID,
            ptyIncarnationId: 'mailbox-incarnation',
            authorityGeneration: 'test',
            observationEpoch: 1,
            capturedAgeMs: 0,
            verdict: 'observed',
            source: 'pty-master',
            foregroundKind: name === 'zsh' ? 'shell' : 'non-shell',
            processName: name
          }
        })
      })
      try {
        await driveToLiveIdle(runtime)
        const run = createBoundRun(db, 'Other foreground program')
        const message = insertDirectRunMessage(db, run.id, 'Held for intended agent')
        runtime.notifyMessageArrived(`run:${run.id}`, 'status')
        await vi.advanceTimersByTimeAsync(1000)
        expect(write).not.toHaveBeenCalled()
        name = other
        await vi.advanceTimersByTimeAsync(65000)
        expect(write).not.toHaveBeenCalled()
        expect(db.getMessageById(message.id)).toMatchObject({ read: 0, delivered_at: null })
        // The existing host reader canonicalizes an npm wrapper's argv to its agent identity.
        const sample = resolvePtyForegroundMembers(
          [
            { pid: 1, ppid: 0, pgid: 1, tpgid: 2, stat: 'S', command: '/bin/zsh' },
            { pid: 2, ppid: 1, pgid: 2, tpgid: 2, stat: 'S', command }
          ],
          2
        )
        expect(sample).toMatchObject({ verdict: 'observed', foregroundKind: 'non-shell' })
        name = sample.verdict === 'observed' ? (sample.processName ?? '') : ''
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
        await vi.advanceTimersByTimeAsync(65000)
        expect(write).toHaveBeenCalledTimes(2)
      } finally {
        db.close()
      }
    }
  )

  it('ends backed-off obligations on consumption, rerouting, retirement and disconnect, and recovers on reconnect', async () => {
    vi.useFakeTimers()
    for (const ending of ['consumed', 'rerouted', 'retired', 'disconnected'] as const) {
      const db = createDatabase('orca-mail-obligation-lifetime-')
      const { runtime, write } = createRuntime(db)
      let inspections = 0
      let shell = true
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getForegroundProcess: async () => null,
        supportsForegroundObservation: () => true,
        inspectProcess: async () => {
          inspections++
          return {
            foregroundProcess: shell ? 'zsh' : 'codex',
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
              processName: shell ? 'zsh' : 'codex'
            }
          }
        }
      })
      await driveToLiveIdle(runtime)
      const run = createBoundRun(db, 'Obligation lifetime')
      const message = insertDirectRunMessage(db, run.id, 'Held mail')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(45000)
      expect(inspections).toBeLessThanOrEqual(4)
      expect(write).not.toHaveBeenCalled()
      if (ending === 'consumed') {
        db.markAsRead([message.id])
      } else if (ending === 'rerouted') {
        db.bindRun({
          runId: run.id,
          coordinatorHandle: 'term_elsewhere',
          coordinatorPaneKey: 'elsewhere:pane'
        })
      } else {
        await runtime.onPtyExit(
          PTY_ID,
          ending === 'retired' ? 0 : -1,
          'mailbox-incarnation',
          ending === 'retired' ? { providerExitObserved: true } : { hostLost: true }
        )
      }
      const before = inspections
      await vi.advanceTimersByTimeAsync(180000)
      expect(inspections).toBe(before)
      expect(write).not.toHaveBeenCalled()
      if (ending === 'disconnected') {
        shell = false
        runtime.registerPty(PTY_ID, WORKTREE_ID, null, {
          tabId: TAB_ID,
          leafId: LEAF_ID,
          incarnationId: 'mailbox-incarnation',
          agentLaunchAuthority: { launchToken: LAUNCH_TOKEN, launchAgent: 'codex' }
        })
        runtime.registerPreAllocatedHandleForPty(PTY_ID, TERMINAL_HANDLE)
        runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', 2)
        await vi.advanceTimersByTimeAsync(1000)
        expect(write.mock.calls.map(([, data]) => data)).toEqual([
          expect.stringContaining('You have 1 orchestration message'),
          '\r'
        ])
        expect(db.getMessageById(message.id)).toMatchObject({
          read: 0,
          delivered_at: expect.any(String),
          pointer_enter_pending: 0
        })
      }
      db.close()
    }
  })
})
