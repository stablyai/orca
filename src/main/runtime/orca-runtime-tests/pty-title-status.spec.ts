import { describe, expect, it, vi } from 'vitest'
import { listWorktrees } from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, createRuntime, syncSinglePty } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('associates controller PTYs with mixed-case Windows and UNC cwd paths', async () => {
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: 'C:\\Repo',
        head: 'abc',
        branch: 'feature/windows',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '//Server/Share/Repo',
        head: 'def',
        branch: 'feature/unc',
        isBare: false,
        isMainWorktree: false
      }
    ])
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [
        { id: 'pty-windows', cwd: 'c:\\repo\\src', title: 'Windows shell' },
        { id: 'pty-unc', cwd: '//server/share/repo/src', title: 'UNC shell' }
      ]
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)

    const terminals = await runtime.listTerminals()

    expect(terminals.terminals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          worktreeId: `${TEST_REPO_ID}::C:\\Repo`,
          worktreePath: 'C:\\Repo'
        }),
        expect.objectContaining({
          worktreeId: `${TEST_REPO_ID}:://Server/Share/Repo`,
          worktreePath: '//Server/Share/Repo'
        })
      ])
    )
  })

  it('uses OSC titles rather than controller process names for rendererless PTYs', async () => {
    const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)

    expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
      title: null
    })

    runtime.onPtyData(ptyId, '\x1b]0;Codex\x07', 123)

    expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
      title: 'Codex'
    })

    expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
      title: 'Codex'
    })
  })

  it('resolves tui-idle when a completion title is coalesced with the next working title', async () => {
    // A coalesced done/working chunk must still expose the idle transition (#1083).
    const runtime = createRuntime()
    syncSinglePty(runtime)
    runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', 100)
    const [terminal] = (await runtime.listTerminals()).terminals
    const wait = runtime.waitForTerminal(terminal.handle, {
      condition: 'tui-idle',
      timeoutMs: 1_000
    })

    runtime.onPtyData('pty-1', '\x1b]0;Codex done\x07\x1b]0;Codex working\x07', 101)

    await expect(wait).resolves.toMatchObject({
      handle: terminal.handle,
      condition: 'tui-idle',
      status: 'running'
    })
  })

  it('ignores the bare cursor-agent native title so synthesized spinner state survives', async () => {
    const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
    const runtime = createRuntime()
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
    })
    runtime.attachWindow(1)
    runtime.markGraphReady(1)

    runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 100)
    // Cursor redraws its bare title while working; retain Orca's synthesized status.
    runtime.onPtyData(ptyId, '\x1b]0;Cursor Agent\x07', 101)

    expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
      title: '⠋ Cursor Agent'
    })
  })

  // The stale-working clear can leave a bare Cursor title over a shell; that title proves identity only.
  it('only records the bare Cursor native title via the stale-working clear', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;Cursor Agent\x07', 100)
      expect((await runtime.listTerminals()).terminals[0].title).not.toBe('Cursor Agent')

      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 101)
      runtime.onPtyData(ptyId, 'agent finished; shell prompt returns\r\n', 102)
      await vi.advanceTimersByTimeAsync(3_000)

      expect((await runtime.listTerminals()).terminals[0].title).toBe('Cursor Agent')
    } finally {
      vi.useRealTimers()
    }
  })

  // Missing foreground evidence must not let a stale Cursor title authorize auto-Enter.
  it('refuses a bare Cursor title while the foreground read is unavailable', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 100)
      runtime.onPtyData(ptyId, 'streaming output with no title\r\n', 101)
      await vi.advanceTimersByTimeAsync(3_000)

      const terminal = (await runtime.listTerminals()).terminals[0]
      expect(terminal.title).toBe('Cursor Agent')
      await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
      await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
        handle: terminal.handle,
        isRunningAgent: false,
        status: null
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not treat a bare Cursor title as an agent once the shell owns the foreground', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      let foreground: string | null = null
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => foreground,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 100)
      runtime.onPtyData(ptyId, 'agent exited; back at the shell\r\n', 101)
      await vi.advanceTimersByTimeAsync(3_000)

      // Auto-Enter here would submit to the shell despite the retained Cursor title.
      foreground = 'zsh'
      const terminal = (await runtime.listTerminals()).terminals[0]
      expect(terminal.title).toBe('Cursor Agent')
      await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
      await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
        handle: terminal.handle,
        isRunningAgent: false,
        status: null
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Confirmed cursor-agent foreground must still authorize a live Cursor pane.
  it('accepts a bare Cursor title when the foreground read confirms cursor-agent', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      let foreground: string | null = null
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => foreground,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 100)
      runtime.onPtyData(ptyId, 'streaming output with no title\r\n', 101)
      await vi.advanceTimersByTimeAsync(3_000)

      foreground = 'cursor-agent'
      const terminal = (await runtime.listTerminals()).terminals[0]
      await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // Exercise the controller-less type-narrowing branch, unreachable through production callers.
  it('refuses a bare Cursor title on a runtime pty with no controller attached', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'cursor-agent',
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 100)
      runtime.onPtyData(ptyId, 'streaming output with no title\r\n', 101)
      await vi.advanceTimersByTimeAsync(3_000)

      const terminal = (await runtime.listTerminals()).terminals[0]
      runtime.setPtyController(null)
      await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a stale working title after 3s of title-less output', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData(ptyId, 'output without a title\r\n', 101)
      expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
        title: 'Codex working'
      })

      await vi.advanceTimersByTimeAsync(3_000)

      expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
        title: 'Codex'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the stale-title timer when the PTY exits', async () => {
    vi.useFakeTimers()
    try {
      const ptyId = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-bg`
      const runtime = createRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [{ id: ptyId, cwd: '/tmp/worktree-a', title: 'shell' }]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyId, '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData(ptyId, 'output without a title\r\n', 101)
      runtime.onPtyExit(ptyId, 0)

      await vi.advanceTimersByTimeAsync(4_000)

      // A disposed tracker's timer must not rewrite a retained dead session's title.
      expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
        title: 'Codex working'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps stale-title timers isolated per PTY', async () => {
    vi.useFakeTimers()
    try {
      const ptyA = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-a`
      const ptyB = `${TEST_REPO_ID}::/tmp/worktree-a@@pty-b`
      const runtime = createRuntime()
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        listProcesses: async () => [
          { id: ptyA, cwd: '/tmp/worktree-a', title: 'shell' },
          { id: ptyB, cwd: '/tmp/worktree-a', title: 'shell' }
        ]
      })
      runtime.attachWindow(1)
      runtime.markGraphReady(1)

      runtime.onPtyData(ptyA, '\x1b]0;Codex working\x07', 100)
      runtime.onPtyData(ptyB, '\x1b]0;Aider working\x07', 100)
      runtime.onPtyData(ptyA, 'output without a title\r\n', 101)

      await vi.advanceTimersByTimeAsync(3_000)

      const { terminals } = await runtime.listTerminals()
      expect(terminals.find((t) => t.tabId === `pty:${ptyA}`)).toMatchObject({ title: 'Codex' })
      expect(terminals.find((t) => t.tabId === `pty:${ptyB}`)).toMatchObject({
        title: 'Aider working'
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
