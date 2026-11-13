import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBoundRun,
  createDatabase,
  createRuntime,
  insertDirectRunMessage,
  PTY_ID,
  TERMINAL_HANDLE,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import { settledWriteStub } from '../../../../providers/testing/settled-pty-write-stub'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

describe('mailbox delivery with current adopted agent evidence', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['command-start', 'gap', 'provider-reset'] as const)(
    'parks mail after command exit and wakes it for the current same-title agent (%s)',
    async (replacement) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-ended-agent-mail-')
      const { runtime } = createRuntime(db, { launchAgent: null })
      const write = vi.fn<(id: string, data: string) => boolean>(() => true)
      let foreground = 'zsh'
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getForegroundProcess: async () => foreground
      })
      const run = createBoundRun(db, 'same-title replacement')
      await runtime.listTerminals()
      runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
      runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, {
        value: 0,
        generation: 'continued'
      })
      const ingest = (data: string) => runtime.onPtyData(PTY_ID, data, Date.now())
      try {
        ingest('\x1b]133;C\x07\x1b]0;claude\x07\x1b]7501;state=idle:app=claude-code\x07')
        ingest('\x1b]133;D;0\x07\x1b]133;A\x07shell% ')
        insertDirectRunMessage(db, run.id, 'For the next live agent')
        runtime.notifyMessageArrived(`run:${run.id}`, 'status')
        await vi.advanceTimersByTimeAsync(12_000)
        await expect(
          runtime.waitForTerminal(TERMINAL_HANDLE, { condition: 'tui-idle' })
        ).resolves.toMatchObject({ satisfied: true })
        expect(write).not.toHaveBeenCalled()
        foreground = 'claude'
        if (replacement === 'gap') {
          runtime.notePtyDataGap(PTY_ID, 4096)
        } else if (replacement === 'provider-reset') {
          runtime.synchronizePtyOutputSequenceFromProvider(
            PTY_ID,
            {
              value: 0,
              generation: 'reset'
            },
            runtime.getPtyOutputSequence(PTY_ID)
          )
        } else {
          ingest('\x1b]133;C\x07')
        }
        ingest('\x1b]0;claude\x07\x1b[?2031h\x1b[?2004h❯\u00a0')
        await vi.advanceTimersByTimeAsync(6_000)
        expect(write.mock.calls.map(([, data]) => data)).toEqual([
          expect.stringContaining('You have 1 orchestration message'),
          '\r'
        ])
      } finally {
        db.close()
      }
    }
  )

  it('restages a pointer before Enter when its command ends during delivery', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-ended-staged-mail-')
    const { runtime } = createRuntime(db, { launchAgent: null })
    let foreground = 'zsh'
    let exitOnPointer = true
    const write = vi.fn<(id: string, data: string) => boolean>((_id, data) => {
      if (exitOnPointer && data.includes('You have 1 orchestration message')) {
        exitOnPointer = false
        runtime.onPtyData(PTY_ID, '\x1b]133;D;0\x07\x1b]133;A\x07shell% ', Date.now())
      }
      return true
    })
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => foreground
    })
    const run = createBoundRun(db, 'staged pointer exit')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    try {
      runtime.onPtyData(
        PTY_ID,
        '\x1b]133;C\x07\x1b]0;claude\x07\x1b]7501;state=idle:app=claude-code\x07',
        Date.now()
      )
      const message = insertDirectRunMessage(db, run.id, 'Keep unread through exit')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(6_000)
      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message')
      ])
      expect(db.areUnreadMessages(`run:${run.id}`, [message.id])).toBe(true)
      expect(db.getPendingMailboxPointerMessages(`run:${run.id}`)).toHaveLength(0)
      foreground = 'claude'
      runtime.onPtyData(
        PTY_ID,
        '\x1b]133;C\x07\x1b]0;claude\x07\x1b[?2031h\x1b[?2004h❯\u00a0',
        Date.now()
      )
      await vi.advanceTimersByTimeAsync(6_000)
      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
      expect(db.areUnreadMessages(`run:${run.id}`, [message.id])).toBe(true)
      expect(db.getPendingMailboxPointerMessages(`run:${run.id}`)).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('holds a reused Claude pane through the next preexec despite the previous program status', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-reuse-status-')
    const { runtime } = createRuntime(db, { launchAgent: null })
    const write = vi.fn<(id: string, data: string) => boolean>(() => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => 'zsh'
    })
    const run = createBoundRun(db, 'reused Claude')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    const ingest = (data: string) => runtime.onPtyData(PTY_ID, data, Date.now())
    try {
      ingest(
        '\x1b]133;C\x07\x1b]0;claude\x07\x1b[?2031h\x1b[?2004h❯\u00a0\x1b]7501;state=idle:app=claude-code\x07'
      )
      ingest('\x1b]7501;state=working:app=claude-code\x07')
      ingest('\x1b]7501;state=done:app=claude-code\x07')
      ingest('\x1b]7501;state=clear\x07\x1b]0;\x07\x1b]133;D;0\x07\x1b]133;A\x07~/repo % ')
      ingest('\x1b]133;C\x07\x1b]0;claude\x07HOOKSTART second invocation\r\n')
      const settled = vi.fn()
      const idle = runtime.waitForTerminal(TERMINAL_HANDLE, {
        condition: 'tui-idle',
        timeoutMs: 60_000
      })
      idle.then(settled, () => {})
      insertDirectRunMessage(db, run.id, 'New invocation brief')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(12_000)

      expect(settled).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
      ingest(
        'HOOKDONE second invocation\r\n\x1b[?2031h\x1b[?2004h❯\u00a0\x1b]7501;state=idle:app=claude-code\x07'
      )
      await vi.advanceTimersByTimeAsync(5_000)
      expect(settled).toHaveBeenCalledTimes(1)
      await expect(idle).resolves.toMatchObject({ satisfied: true })
      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
    } finally {
      db.close()
    }
  })

  it.each(['\x1b]133;D;0\x07\x1b]133;A\x07', ''])(
    'does not renew a retired root from child-only reports across replacement (%j)',
    async (exit) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-retired-root-')
      const { runtime } = createRuntime(db, { launchAgent: null })
      const write = vi.fn<(id: string, data: string) => boolean>(() => true)
      runtime.setPtyController({
        write,
        writeWithSettlement: settledWriteStub(write),
        kill: vi.fn(),
        getForegroundProcess: async () => 'zsh'
      })
      const run = createBoundRun(db, 'retired root')
      await runtime.listTerminals()
      runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
      const ingest = (data: string) => runtime.onPtyData(PTY_ID, data, Date.now())
      try {
        ingest(
          '\x1b]133;C\x07\x1b]0;claude\x07\x1b[?2031h\x1b[?2004h❯\u00a0\x1b]7501;state=done:app=claude-code\x07\x1b]7501;state=done:id=job\x07'
        )
        ingest(`${exit}\x1b]133;C\x07\x1b]0;claude\x07new hook\r\n`)
        ingest('\x1b]7501;state=clear:id=job\x07')
        const settled = vi.fn()
        const wait = runtime.waitForTerminal(TERMINAL_HANDLE, {
          condition: 'tui-idle',
          timeoutMs: 60_000
        })
        wait.then(settled, () => {})
        insertDirectRunMessage(db, run.id, 'Current invocation only')
        runtime.notifyMessageArrived(`run:${run.id}`, 'status')
        await vi.advanceTimersByTimeAsync(12_000)
        expect(settled).not.toHaveBeenCalled()
        expect(write).not.toHaveBeenCalled()
        ingest('\x1b]7501;state=idle:app=claude-code\x07')
        await vi.advanceTimersByTimeAsync(5_000)
        await expect(wait).resolves.toMatchObject({ satisfied: true })
        expect(write.mock.calls.map(([, data]) => data)).toEqual([
          expect.stringContaining('You have 1 orchestration message'),
          '\r'
        ])
      } finally {
        db.close()
      }
    }
  )

  it('keeps wait and mail pending when child pressure evicts a working root', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-evicted-root-')
    const { runtime } = createRuntime(db, { launchAgent: null })
    const write = vi.fn<(id: string, data: string) => boolean>(() => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => 'zsh'
    })
    const run = createBoundRun(db, 'root eviction')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    const ingest = (data: string) => runtime.onPtyData(PTY_ID, data, Date.now())
    try {
      ingest('\x1b]133;C\x07\x1b]0;claude\x07\x1b]7501;state=working:app=claude-code\x07')
      const settled = vi.fn()
      const wait = runtime.waitForTerminal(TERMINAL_HANDLE, {
        condition: 'tui-idle',
        timeoutMs: 60_000
      })
      wait.then(settled, () => {})
      insertDirectRunMessage(db, run.id, 'Wait for current root')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      for (let child = 0; child < 256; child++) {
        ingest(`\x1b]7501;state=working:id=job${child}\x07`)
      }
      await vi.advanceTimersByTimeAsync(12_000)
      expect(settled).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
      // Clear the still-working children, then let the actual root report readiness.
      ingest('\x1b]7501;state=clear\x07\x1b]7501;state=idle:app=claude-code\x07')
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(wait).resolves.toMatchObject({ satisfied: true })
      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
    } finally {
      db.close()
    }
  })

  it('delivers working-turn mail only after an adopted wrapper has current composer evidence', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-adopted-working-mail-')
    const { runtime } = createRuntime(db, { launchAgent: null })
    const write = vi.fn<(id: string, data: string) => boolean>(() => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => 'node',
      confirmForegroundProcess: async () => null
    })
    const run = createBoundRun(db, 'adopted Claude')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    const working = '\x1b]9999;{"state":"working","agentType":"claude"}\x07'
    runtime.onPtyData(PTY_ID, `\x1b]133;C\x07\x1b]0;claude\x07hook text\r\n${working}`, Date.now())
    insertDirectRunMessage(db, run.id, 'Worker heartbeat')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(write).not.toHaveBeenCalled()
    runtime.onPtyData(PTY_ID, `\x1b[?2031h\x1b[?2004h❯\u00a0${working}`, Date.now())
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })

  it('preserves adopted OMP identity, readiness and mail across a split recorded app zone', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-adopted-omp-app-zone-')
    const { runtime } = createRuntime(db, { launchAgent: null })
    const write = vi.fn<(id: string, data: string) => boolean>(() => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getSize: () => ({ cols: 100, rows: 30 }),
      getForegroundProcess: async () => 'omp'
    })
    const run = createBoundRun(db, 'adopted OMP')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    runtime.onPtyData(PTY_ID, '\x1b]133;C\x07\x1b]0;π > capture-cwd\x07', Date.now())
    await runtime.isTerminalRunningSettledPromptAgent(TERMINAL_HANDLE)
    expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('omp')
    const recorded = readFileSync(
      join(__dirname, '../../../__fixtures__/omp-user-bubble-osc133-zone.txt'),
      'utf8'
    )
    const prefix = '\x1b]133;B\x07\x1b]133;C\x07'
    const cut = recorded.indexOf(prefix) + prefix.length
    runtime.onPtyData(PTY_ID, recorded.slice(0, cut), Date.now())
    const idle = runtime.waitForTerminal(TERMINAL_HANDLE, {
      condition: 'tui-idle',
      timeoutMs: 60_000
    })
    const settled = vi.fn()
    idle.then(settled, () => {})
    insertDirectRunMessage(db, run.id, 'OMP heartbeat')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(12_000)
    expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('omp')
    expect(settled).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    runtime.onPtyData(PTY_ID, recorded.slice(cut), Date.now())
    runtime.onPtyData(PTY_ID, '\x1b]0;π > capture-cwd\x07', Date.now())
    const keepalive = setInterval(() => runtime.onPtyData(PTY_ID, '\x1b[?2004h', Date.now()), 1000)
    await vi.advanceTimersByTimeAsync(5_000)
    clearInterval(keepalive)
    expect(settled).toHaveBeenCalled()
    await expect(idle).resolves.toMatchObject({ satisfied: true })
    expect((await runtime.listTerminals()).terminals[0]?.agentIdentity).toBe('omp')
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })

  it('delivers working mail to a current adopted non-TUI terminal agent', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-working-dsb-mail-')
    const { runtime } = createRuntime(db, { launchAgent: null })
    const write = vi.fn<(id: string, data: string) => boolean>(() => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => 'dsb'
    })
    const run = createBoundRun(db, 'adopted dsb')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    runtime.onPtyData(PTY_ID, '\x1b]133;C\x07\x1b]0;⠋ - Build - DeepSeek Build\x07', Date.now())
    await runtime.isTerminalRunningSettledPromptAgent(TERMINAL_HANDLE)
    expect(runtime.getPaneTerminalAgent(PTY_ID)).toBe('dsb')
    insertDirectRunMessage(db, run.id, 'Build heartbeat')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
    db.close()
  })
})

it('holds wait and mail on the observed bash preexec, then delivers to the current Codex composer', async () => {
  vi.useFakeTimers()
  const db = createDatabase('orca-shell-candidate-')
  const { runtime } = createRuntime(db, { launchAgent: null })
  const write = vi.fn<(id: string, data: string) => boolean>(() => true)
  let processName = 'bash'
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: () => true,
    getForegroundProcess: async () => processName,
    getSize: () => ({ cols: 120, rows: 40 }),
    inspectProcess: async () => ({
      foregroundProcess: processName,
      hasChildProcesses: true,
      foregroundObservation: {
        ptyId: PTY_ID,
        ptyIncarnationId: 'mailbox-incarnation',
        authorityGeneration: 'host-1',
        observationEpoch: 1,
        capturedAgeMs: 0,
        verdict: 'observed',
        source: 'pty-master',
        foregroundKind: processName === 'bash' ? 'shell' : 'non-shell',
        processName
      }
    })
  })
  try {
    const run = createBoundRun(db, 'Current Codex')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    const ingest = (data: string) => runtime.onPtyData(PTY_ID, data, Date.now())
    ingest('\x1b]133;C\x07\x1b]0;codex\x07HOOKSTART current invocation\r\n')
    const settled = vi.fn()
    const wait = runtime.waitForTerminal(TERMINAL_HANDLE, {
      condition: 'tui-idle',
      timeoutMs: 60_000
    })
    wait.then(settled, () => {})
    insertDirectRunMessage(db, run.id, 'Current invocation message')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(12_000)
    expect(settled).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    processName = 'codex'
    ingest(
      'HOOKDONE current invocation\r\nOpenAI Codex (v0.157.0)\r\nmodel: gpt-6.1-sol\r\ndirectory: /repo/app\r\n· /model to change\r\n'
    )
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
  } finally {
    db.close()
    vi.useRealTimers()
  }
})

it('does not deliver a new brief using the previous invocation inline screen', async () => {
  vi.useFakeTimers()
  const db = createDatabase('orca-old-inline-')
  const { runtime } = createRuntime(db, { launchAgent: null })
  const write = vi.fn<(id: string, data: string) => boolean>(() => true)
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: () => true,
    getForegroundProcess: async () => 'codex',
    getSize: () => ({ cols: 120, rows: 40 })
  })
  try {
    const run = createBoundRun(db, 'Replacement Codex')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    const ingest = (data: string) => runtime.onPtyData(PTY_ID, data, Date.now())
    const header =
      'OpenAI Codex (v0.157.0)\r\nmodel: gpt-6.1-sol\r\ndirectory: /repo/app\r\n· /model to change\r\n'
    ingest(`\x1b]133;C\x07\x1b]0;codex\x07${header}`)
    await vi.advanceTimersByTimeAsync(2000)
    ingest('/quit\r\n\x1b]133;D;0\x07\x1b]133;A\x07qa$ codex\r\n\x1b]133;C\x07\x1b]0;codex\x07')
    await runtime.listTerminals()
    insertDirectRunMessage(db, run.id, 'Replacement brief')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(write).not.toHaveBeenCalled()
    ingest(`\x1b[H${header}`)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
  } finally {
    db.close()
    vi.useRealTimers()
  }
})

it('requests positive shell evidence for wait and mail already registered before command start', async () => {
  vi.useFakeTimers()
  const db = createDatabase('orca-pre-command-interest-')
  const { runtime } = createRuntime(db, { launchAgent: null })
  const write = vi.fn<(id: string, data: string) => boolean>(() => true)
  const inspect = vi.fn(async () => ({
    foregroundProcess: 'zsh',
    hasChildProcesses: true,
    foregroundObservation: {
      ptyId: PTY_ID,
      ptyIncarnationId: 'mailbox-incarnation',
      authorityGeneration: 'host-1',
      observationEpoch: 1,
      capturedAgeMs: 0,
      verdict: 'observed' as const,
      source: 'pty-master' as const,
      foregroundKind: 'shell' as const,
      processName: 'zsh'
    }
  }))
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: vi.fn(),
    getForegroundProcess: async () => 'zsh',
    inspectProcess: inspect
  })
  try {
    const run = createBoundRun(db, 'pre-command wait')
    await runtime.listTerminals()
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
    const settled = vi.fn()
    const wait = runtime.waitForTerminal(TERMINAL_HANDLE, {
      condition: 'tui-idle',
      timeoutMs: 60000
    })
    wait.then(settled, () => {})
    insertDirectRunMessage(db, run.id, 'Only after current composer')
    runtime.notifyMessageArrived(`run:${run.id}`, 'status')
    runtime.onPtyData(PTY_ID, '\x1b]133;C\x07\x1b]0;claude\x07hook start\r\n', Date.now())
    await vi.advanceTimersByTimeAsync(0)
    expect(inspect).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(12000)
    expect(settled).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    runtime.onPtyData(PTY_ID, '\x1b[?2031h\x1b[?2004h❯\u00a0', Date.now())
    await vi.advanceTimersByTimeAsync(5000)
    await expect(wait).resolves.toMatchObject({ satisfied: true })
    expect(write.mock.calls.map(([, data]) => data)).toEqual([
      expect.stringContaining('You have 1 orchestration message'),
      '\r'
    ])
  } finally {
    db.close()
    vi.useRealTimers()
  }
})

it.each(['title', 'program'] as const)(
  'retains old title provenance through activity clear, then accepts current %s authority',
  async (current) => {
    vi.useFakeTimers()
    const db = createDatabase('orca-title-clear-origin-')
    const { runtime } = createRuntime(db, { launchAgent: null })
    const write = vi.fn<(id: string, data: string) => boolean>(() => true)
    runtime.setPtyController({
      write,
      writeWithSettlement: settledWriteStub(write),
      kill: vi.fn(),
      getForegroundProcess: async () => 'codex'
    })
    try {
      const run = createBoundRun(db, 'title activity clear')
      await runtime.listTerminals()
      runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID })
      const ingest = (data: string) => runtime.onPtyData(PTY_ID, data, Date.now())
      ingest('\x1b]133;C\x07\x1b]0;Codex ready\x07\x1b]7501;state=idle:app=codex\x07')
      ingest('\x1b]7501;state=clear\x07')
      ingest('\x1b]133;C\x07new hook\r\n')
      await runtime.listTerminals()
      const settled = vi.fn()
      const wait = runtime.waitForTerminal(TERMINAL_HANDLE, {
        condition: 'tui-idle',
        timeoutMs: 60000
      })
      wait.then(settled, () => {})
      insertDirectRunMessage(db, run.id, 'Only current title or status')
      runtime.notifyMessageArrived(`run:${run.id}`, 'status')
      await vi.advanceTimersByTimeAsync(6000)
      expect(settled).not.toHaveBeenCalled()
      expect(write).not.toHaveBeenCalled()
      ingest(current === 'title' ? '\x1b]0;Codex ready\x07' : '\x1b]7501;state=idle:app=codex\x07')
      await vi.advanceTimersByTimeAsync(5000)
      await expect(wait).resolves.toMatchObject({ satisfied: true })
      expect(write.mock.calls.map(([, data]) => data)).toEqual([
        expect.stringContaining('You have 1 orchestration message'),
        '\r'
      ])
    } finally {
      db.close()
      vi.useRealTimers()
    }
  }
)
