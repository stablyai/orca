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
    // Why: batching can coalesce "task done" + next working title into one chunk; a last-title reader misses the idle and hangs (#1083 class).
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
    // cursor-agent re-emits its bare native title on internal redraws while still working; it must not stomp the synthesized working title.
    runtime.onPtyData(ptyId, '\x1b]0;Cursor Agent\x07', 101)

    expect((await runtime.listTerminals()).terminals[0]).toMatchObject({
      title: '⠋ Cursor Agent'
    })
  })

  // Why: this pins the mechanism the refusals below exist for. cursor-agent emits only the
  // bare native title, and the tracker drops it on sight — so a pane can never hold it
  // because Cursor said so *now*. The one route into main's records is the stale-working
  // clear stripping the spinner off Orca's synthesized title after 3s of quiet output, and
  // that fires whether Cursor parked idle or exited and the shell took the pane back. That
  // is exactly why the title cannot tell a live pane from a dead one.
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

      // Live from cursor-agent: dropped, never recorded.
      runtime.onPtyData(ptyId, '\x1b]0;Cursor Agent\x07', 100)
      expect((await runtime.listTerminals()).terminals[0].title).not.toBe('Cursor Agent')

      // Orca's synthesized spinner, then quiet output: the clear strips it to the bare title.
      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', 101)
      runtime.onPtyData(ptyId, 'agent finished; shell prompt returns\r\n', 102)
      await vi.advanceTimersByTimeAsync(3_000)

      expect((await runtime.listTerminals()).terminals[0].title).toBe('Cursor Agent')
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: this pane reads no foreground and the next reads a live shell, yet both hold the
  // same bare title the stale-working clear left behind. Neither read makes that title
  // liveness, so both must refuse.
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

      // cursor-agent is gone and the user's shell owns the pane, but the title still reads
      // "Cursor Agent". A guarded send here would auto-submit Enter into that shell.
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

  // Why: the refusals here must stay scoped to missing evidence. A working foreground read
  // is what unlocks a live Cursor pane — and is the layer to fix if one is ever refused.
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

  // Why: pins the type-narrowing branch, not a reachable state — no caller detaches the
  // controller. It is the runtime-owned pty path, which the window-graph leaf tests below
  // never reach, so nothing else would notice it being widened.
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

      // The dead session keeps its factual last title; the disposed tracker's stale-title rewrite must not fire into the retained record.
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
      // Only A receives title-less output, so only A's stale timer arms.
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
