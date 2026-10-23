import './rpc/unused-default-rpc-methods.test-fixture'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalAutomatedInputGuard } from './terminal-automated-input-guard'
import type { WriteSettlement } from '../../shared/pty-write-settlement'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  PTY_ID,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))
vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/draft',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/draft',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

const HUMAN_DRAFT = 'human draft stays here'
const composer = (text: string) =>
  `\x1b[2J\x1b[H\x1b[1m›\x1b[22m ${text}\x1b7\r\n \r\n\x1b[38;2;242;181;144mContext 0% used\x1b[0m\x1b8`

describe('automated terminal human draft admission', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses an automated prompt before writing into an old recognized human draft', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', composer(HUMAN_DRAFT), Date.now())
    await runtime.serializeMainTerminalBuffer('pty-prompt')
    expect(await runtime.readTerminal(handle, { screen: true })).toMatchObject({
      draft: HUMAN_DRAFT
    })
    await vi.advanceTimersByTimeAsync(60_000)
    const sent = runtime.sendTerminalAgentPrompt(handle, 'automated task', { inputKind: 'driving' })
    const result = sent.catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await result).toMatchObject({ message: 'terminal_composer_occupied' })
    expect(writes).toEqual([])
    expect(await runtime.readTerminal(handle, { screen: true })).toMatchObject({
      draft: HUMAN_DRAFT
    })
  })

  it('keeps real SQLite mail unread without writing a pointer into an old recognized draft', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-human-draft-')
    try {
      const { runtime, write } = createRuntime(db)
      const run = createBoundRun(db, 'human draft admission')
      const message = insertDirectRunMessage(db, run.id, 'durable unread mail')
      runtime.onPtyData(PTY_ID, composer(HUMAN_DRAFT), Date.now())
      await runtime.serializeMainTerminalBuffer(PTY_ID)
      expect(await runtime.readTerminal(TERMINAL_HANDLE, { screen: true })).toMatchObject({
        draft: HUMAN_DRAFT
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await driveToLiveIdle(runtime)
      await vi.runAllTimersAsync()
      expect(write.mock.calls).toEqual([])
      expect(db.getMessageById(message.id)).toMatchObject({ read: 0, delivered_at: null })
      expect(await runtime.readTerminal(TERMINAL_HANDLE, { screen: true })).toMatchObject({
        draft: HUMAN_DRAFT
      })
    } finally {
      db.close()
    }
  })

  it.each(['', 'unsupported shell screen'])(
    'allows an empty or unknown screen (%s) and submits exactly once',
    async (screen) => {
      vi.useFakeTimers()
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          runtime.terminalRunFacts.recordInput('pty-prompt', 'driving', data)
          if (data === '\r') {
            runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
          } else {
            runtime.onPtyData('pty-prompt', composer('automated task'), Date.now())
          }
        }
      )
      runtime.onPtyData('pty-prompt', screen ? screen : composer(''), Date.now())
      const sent = runtime.sendTerminalAgentPrompt(handle, 'automated task', {
        inputKind: 'driving'
      })
      await vi.runAllTimersAsync()
      await expect(sent).resolves.toMatchObject({ accepted: true })
      expect(writes).toHaveLength(2)
      expect(writes.filter((data) => data === '\r')).toHaveLength(1)
    }
  )

  it('rejects same-millisecond takeover during beforeWrite without pasting', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', composer(''), Date.now())
    const sent = runtime
      .sendTerminalAgentPrompt(handle, 'automated task', {
        inputKind: 'driving',
        beforeWrite: async () => {
          runtime.terminalRunFacts.recordInput('pty-prompt', 'driving', 'a', 42)
          runtime.terminalRunFacts.recordInput('pty-prompt', 'driving', 'b', 42)
        }
      })
      .catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await sent).toMatchObject({ message: 'terminal_input_changed' })
    expect(writes).toEqual([])
  })

  it('rechecks a newly rendered draft after an awaited beforeWrite', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', composer(''), Date.now())
    const sent = runtime
      .sendTerminalAgentPrompt(handle, 'automated task', {
        inputKind: 'driving',
        beforeWrite: async () => {
          runtime.onPtyData('pty-prompt', composer(HUMAN_DRAFT), Date.now())
        }
      })
      .catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await sent).toMatchObject({ message: 'terminal_composer_occupied' })
    expect(writes).toEqual([])
  })

  it('does not send delayed Enter after another driving input takes over its pasted prompt', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        runtime.terminalRunFacts.recordInput('pty-prompt', 'driving', data)
        setTimeout(() => {
          runtime.terminalRunFacts.recordInput('pty-prompt', 'driving', ' human addition')
          runtime.onPtyData('pty-prompt', composer('automated task human addition'), Date.now())
        }, 1)
      }
    )
    runtime.onPtyData('pty-prompt', composer(''), Date.now())
    const sent = runtime
      .sendTerminalAgentPrompt(handle, 'automated task', { inputKind: 'driving' })
      .catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await sent).toMatchObject({ message: 'terminal_input_changed' })
    expect(writes).toHaveLength(1)
    expect(writes).not.toContain('\r')
    expect(await runtime.readTerminal(handle, { screen: true })).toMatchObject({
      draft: 'automated task human addition'
    })
  })

  it('preserves ordinary raw human writes into an occupied composer', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', composer(HUMAN_DRAFT), Date.now())
    await expect(
      runtime.sendTerminal(handle, { text: ' more human text' }, { inputKind: 'driving' })
    ).resolves.toMatchObject({ accepted: true })
    expect(writes).toEqual([' more human text'])
  })

  it('submits its own mailbox pointer once even when the pointer renders as a recognized draft', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-own-pointer-')
    try {
      const { runtime, write } = createRuntime(db)
      write.mockImplementation((ptyId: string, data: string) => {
        runtime.terminalRunFacts.recordInput(ptyId, 'driving', data)
        if (data !== '\r') {
          runtime.onPtyData(ptyId, composer('own orchestration pointer'), Date.now())
        }
        return true
      })
      const run = createBoundRun(db, 'empty composer')
      const message = insertDirectRunMessage(db, run.id, 'mail')
      runtime.onPtyData(PTY_ID, composer(''), Date.now())
      await driveToLiveIdle(runtime)
      await vi.runAllTimersAsync()
      expect(write.mock.calls.map(([, data]) => data)).toHaveLength(2)
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1)
      expect(db.getMessageById(message.id)?.delivered_at).toEqual(expect.any(String))
    } finally {
      db.close()
    }
  })

  it('retains unread attempted mail and never submits after takeover during remote pointer settlement', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-pointer-takeover-')
    try {
      const { runtime, write } = createRuntime(db)
      const settled = Promise.withResolvers<WriteSettlement>()
      runtime.setPtyController({
        write: () => true,
        writeWithSettlement: (ptyId, data) => {
          runtime.terminalRunFacts.recordInput(ptyId, 'driving', data)
          write(ptyId, data)
          return settled.promise
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const run = createBoundRun(db, 'delayed remote settlement')
      const message = insertDirectRunMessage(db, run.id, 'durable mail')
      runtime.onPtyData(PTY_ID, composer(''), Date.now())
      await driveToLiveIdle(runtime)
      expect(write.mock.calls).toHaveLength(1)
      runtime.terminalRunFacts.recordInput(PTY_ID, 'driving', 'human takeover', Date.now())
      runtime.onPtyData(PTY_ID, composer('pointer human takeover'), Date.now())
      settled.resolve({ outcome: 'accepted' })
      await vi.runAllTimersAsync()
      expect(write.mock.calls).toHaveLength(1)
      expect(db.getMessageById(message.id)).toMatchObject({ read: 0, pointer_enter_pending: 2 })
      runtime.onPtyData(PTY_ID, '\x1b]0;Codex done\x07', Date.now())
      await vi.runAllTimersAsync()
      expect(write.mock.calls).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it.each(['unknown', 'working', 'takeover', 'own-prompt'] as const)(
    'retries Codex Enter only for the unchanged owned prompt (%s)',
    async (scenario) => {
      vi.useFakeTimers()
      let enters = 0
      const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
        (runtime, data) => {
          runtime.terminalRunFacts.recordInput('pty-prompt', 'driving', data)
          if (data !== '\r') {
            if (scenario !== 'unknown') {
              runtime.onPtyData('pty-prompt', composer('automated task'), Date.now())
            }
            return
          }
          enters += 1
          if (scenario === 'working' || enters === 2) {
            runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
          }
          if (scenario === 'takeover') {
            setTimeout(() => {
              runtime.terminalRunFacts.recordInput('pty-prompt', 'driving', 'new followup')
              runtime.onPtyData('pty-prompt', composer('new followup'), Date.now())
            }, 1)
          }
        },
        'codex'
      )
      runtime.onPtyData('pty-prompt', composer(''), Date.now())
      const sent = runtime.sendTerminalAgentPrompt(handle, 'automated task', {
        inputKind: 'driving',
        composerReady: true,
        acceptQueued: true,
        requestId: `retry-${scenario}`,
        observationTimeoutMs: 50
      })
      await vi.runAllTimersAsync()
      await expect(sent).resolves.toMatchObject({ accepted: true })
      expect(writes.filter((data) => data === '\r')).toHaveLength(scenario === 'own-prompt' ? 2 : 1)
    }
  )

  it('preserves an initial launch prompt into an unoccupied composer', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        runtime.terminalRunFacts.recordInput('pty-prompt', 'launch', data)
        if (data === '\r') {
          runtime.onPtyData('pty-prompt', '\x1b]0;Codex working\x07', Date.now())
        }
      }
    )
    runtime.onPtyData('pty-prompt', composer(''), Date.now())
    const sent = runtime.sendTerminalAgentPrompt(handle, 'initial task', { inputKind: 'launch' })
    await vi.runAllTimersAsync()
    await expect(sent).resolves.toMatchObject({ accepted: true })
    expect(writes).toHaveLength(2)
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('does not adopt reentrant competing input while capturing its own paste revision', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (runtime, data) => {
        runtime.terminalRunFacts.recordInput('pty-prompt', 'driving', data, 42)
        runtime.terminalRunFacts.recordInput('pty-prompt', 'driving', 'competing input', 42)
      }
    )
    const sent = runtime
      .sendTerminalAgentPrompt(handle, 'automated task', { inputKind: 'driving' })
      .catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await sent).toMatchObject({ message: 'terminal_input_changed' })
    expect(writes).toHaveLength(1)
    expect(writes).not.toContain('\r')
  })

  it('refuses draft output arriving after admission resolves but before paste', async () => {
    vi.useFakeTimers()
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    runtime.onPtyData('pty-prompt', composer(''), Date.now())
    await runtime.serializeMainTerminalBuffer('pty-prompt')
    const hasAdmission = (
      value: unknown
    ): value is {
      admitTerminalAutomatedInput: (
        ptyId: string,
        guard?: TerminalAutomatedInputGuard
      ) => Promise<TerminalAutomatedInputGuard>
    } =>
      typeof value === 'object' &&
      value !== null &&
      'admitTerminalAutomatedInput' in value &&
      typeof value.admitTerminalAutomatedInput === 'function'
    if (!hasAdmission(runtime)) {
      throw new Error('missing automated input admission')
    }
    const host = runtime
    const original = host.admitTerminalAutomatedInput.bind(runtime)
    vi.spyOn(host, 'admitTerminalAutomatedInput').mockImplementation(async (...args) => {
      const admitted = await original(...args)
      queueMicrotask(() => runtime.onPtyData('pty-prompt', composer(HUMAN_DRAFT), Date.now()))
      return admitted
    })
    const sent = runtime
      .sendTerminalAgentPrompt(handle, 'automated task', { inputKind: 'driving' })
      .catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await runtime.readTerminal(handle, { screen: true })).toMatchObject({
      draft: HUMAN_DRAFT
    })
    expect(writes).toEqual([])
    expect(await sent).toMatchObject({ message: 'terminal_input_changed' })
  })

  it('allows an unoccupied provider snapshot ahead of the local output stream', async () => {
    vi.useFakeTimers()
    const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => undefined)
    const writes: string[] = []
    const serializeProviderBuffer = vi.fn(async () => ({
      data: composer(''),
      cols: 100,
      rows: 30,
      seq: 1000,
      source: 'headless' as const,
      alternateScreen: true
    }))
    runtime.setPtyController({
      write: (ptyId, data) => {
        writes.push(data)
        runtime.terminalRunFacts.recordInput(ptyId, 'driving', data)
        if (data === '\r') {
          runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', Date.now())
        }
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeProviderBuffer
    })
    runtime.synchronizePtyOutputSequenceFromProvider('pty-prompt', {
      value: 100,
      generation: 'continued'
    })
    const sent = runtime.sendTerminalAgentPrompt(handle, 'automated task', { inputKind: 'driving' })
    await vi.runAllTimersAsync()
    await expect(sent).resolves.toMatchObject({ accepted: true })
    expect(serializeProviderBuffer).toHaveBeenCalled()
    expect(writes).toHaveLength(2)
    expect(writes.filter((data) => data === '\r')).toHaveLength(1)
  })

  it('resumes parked unread mail on fresh idle after the recognized draft is cleared', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-draft-clear-redrive-')
    try {
      const { runtime, write } = createRuntime(db)
      const run = createBoundRun(db, 'mail redrive after draft clear')
      const message = insertDirectRunMessage(db, run.id, 'mail retained')
      runtime.onPtyData(PTY_ID, composer(HUMAN_DRAFT), Date.now())
      await runtime.serializeMainTerminalBuffer(PTY_ID)
      await driveToLiveIdle(runtime)
      await vi.runAllTimersAsync()
      expect(write.mock.calls).toHaveLength(0)
      expect(db.getMessageById(message.id)).toMatchObject({
        read: 0,
        pointer_enter_pending: 0,
        delivered_at: null
      })
      runtime.terminalRunFacts.recordInput(PTY_ID, 'driving', '\x15')
      runtime.onPtyData(PTY_ID, composer(''), Date.now())
      await runtime.serializeMainTerminalBuffer(PTY_ID)
      await driveToLiveIdle(runtime)
      await vi.runAllTimersAsync()
      expect(write.mock.calls).toHaveLength(2)
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1)
      expect(db.getMessageById(message.id)).toMatchObject({
        read: 0,
        pointer_enter_pending: 0,
        delivered_at: expect.any(String)
      })
    } finally {
      db.close()
    }
  })
})
