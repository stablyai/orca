import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('lets Claude agents management titles clear stale runtime-created title status', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastAgentStatus: 'working' | null
            lastOscTitle: string | null
            lastOscTitleAt: number | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastAgentStatus = 'working'
    pty.lastOscTitle = 'claude agents'
    pty.lastOscTitleAt = 0

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('does not recognize live Claude agents panes from a Claude foreground process', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('lets Claude agents pane titles override stale live-leaf title status', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('lets Claude agents OSC titles override stale live-leaf pane titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude agents\x07', 100)
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('does not let stale tab-level Claude agents titles suppress current pane activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', {
      tabTitle: 'claude agents',
      paneTitle: 'claude working'
    })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
  })

  it('does not let stale tab-level agent titles override current neutral pane titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1', {
      tabTitle: 'claude working',
      paneTitle: 'bash'
    })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('does not let stale live-leaf status override current neutral pane titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(false)
  })

  it('does not expose stale live-leaf agent status after Claude agents title supersedes it', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    runtime.onPtyData('pty-1', '\x1b]0;claude working\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    const [terminal] = (await runtime.listTerminals()).terminals

    expect(runtime.getAgentStatusForHandle(terminal.handle)).toBeNull()
  })

  it('lists live terminals with fresh pane titles over stale tab titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'claude working',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'claude agents'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    expect(terminal.title).toBe('claude agents')
  })

  it('does not let stale Claude agents OSC titles suppress current pane activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude agents' })
    runtime.onPtyData('pty-1', '\x1b]0;claude agents\x07', 100)
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'claude working' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
  })

  it('lets adopted pane Claude agents titles override stale PTY-handle activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'claude working'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude working\x07', 100)

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'claude agents' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('lets adopted neutral pane titles override stale PTY-handle activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'claude working'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude working\x07', 100)

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('lets adopted neutral pane titles use non-shell foreground fallback', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('lets adopted neutral pane titles retry wrapper foregrounds until recognized', async () => {
    const getForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('codex')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('does not poll a wrapper foreground for a speculative CLI prompt send', async () => {
    const getForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('codex')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(
      runtime.isTerminalRunningAgent(handle, { retryForegroundWrappers: false })
    ).resolves.toBe(false)
    expect(getForegroundProcess).toHaveBeenCalledTimes(1)
  })

  it.each(['claude', 'codex'] as const)(
    'authorizes settled CLI prompts only after positive %s foreground identity',
    async (agent) => {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => agent
      })
      syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
      const [terminal] = (await runtime.listTerminals()).terminals

      await expect(runtime.isTerminalRunningSettledPromptAgent(terminal.handle)).resolves.toBe(true)
    }
  )

  it('keeps a recognized non-target agent on legacy CLI prompt delivery', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'gemini'
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
    await expect(runtime.isTerminalRunningSettledPromptAgent(terminal.handle)).resolves.toBe(false)
  })

  it('keeps stale Codex launch identity on legacy delivery after the shell returns', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'zsh'
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'Codex working',
      launchAgent: 'codex'
    })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
    await expect(runtime.isTerminalRunningSettledPromptAgent(handle)).resolves.toBe(false)
  })

  it('waits for delayed wrapper foreground cache enrichment', async () => {
    const getForegroundProcess = vi.fn(async () => (Date.now() >= 4_000 ? 'codex' : 'node'))
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })
    vi.useFakeTimers()
    vi.setSystemTime(0)
    try {
      const result = runtime.isTerminalRunningAgent(handle)
      await vi.advanceTimersByTimeAsync(4_200)

      await expect(result).resolves.toBe(true)
      expect(getForegroundProcess.mock.calls.length).toBeGreaterThan(20)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not recognize arbitrary foreground TUIs as running agents', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'vim'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('does not recognize unresolved wrapper foregrounds as running agents', async () => {
    const getForegroundProcess = vi.fn().mockResolvedValue('node')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'bash',
      title: 'bash'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })

    vi.useFakeTimers()
    try {
      const result = runtime.isTerminalRunningAgent(handle)
      await vi.advanceTimersByTimeAsync(7_000)

      await expect(result).resolves.toBe(false)
      expect(getForegroundProcess.mock.calls.length).toBeGreaterThan(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets live neutral pane titles retry wrapper foregrounds until recognized', async () => {
    const getForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('codex')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    syncSinglePty(runtime, 'pty-1', { paneTitle: 'bash' })
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.isTerminalRunningAgent(terminal.handle)).resolves.toBe(true)
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('keeps Claude management titles suppressed after wrapper foreground refreshes', async () => {
    const getForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce('node')
      .mockResolvedValueOnce('claude')
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'claude agents' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
    expect(getForegroundProcess).toHaveBeenCalledTimes(2)
  })

  it('lets adopted Claude agents pane titles use non-Claude foreground fallback', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'claude agents' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('keeps ready prompt evidence when an adopted pane title is neutral', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'Codex working'
    })
    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'bash' })
    runtime.onPtyData(
      'pty-bg',
      ['OpenAI Codex', 'Model: gpt-5.4', 'Directory: /tmp/worktree-a'].join('\n'),
      100
    )

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('lets adopted pane agent titles override stale PTY Claude agents titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude agents\x07', 100)

    syncSinglePty(runtime, 'pty-bg', { paneTitle: 'claude working' })

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('lets current Claude agents PTY titles override stale runtime-created OSC titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastOscTitle: string | null
            lastOscTitleAt: number | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastOscTitle = 'claude working'
    pty.lastOscTitleAt = 0

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })

  it('does not let stale Claude agents OSC titles suppress current PTY title activity', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude',
      title: 'claude working'
    })
    const pty = (
      runtime as unknown as {
        ptysById: Map<
          string,
          {
            lastOscTitle: string | null
            lastOscTitleAt: number | null
          }
        >
      }
    ).ptysById.get('pty-bg')
    expect(pty).toBeDefined()
    if (!pty) {
      throw new Error('expected runtime PTY record')
    }
    pty.lastOscTitle = 'claude agents'
    pty.lastOscTitleAt = 0

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('recognizes fresh runtime-created agent OSC titles over stale Claude agents launch titles', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })
    runtime.onPtyData('pty-bg', '\x1b]0;claude working\x07', 100)

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(true)
  })

  it('keeps Claude agents management evidence when controller refresh reports a Claude process title', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude',
      listProcesses: async () => [{ id: 'pty-bg', cwd: TEST_WORKTREE_PATH, title: 'claude' }]
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude agents',
      title: 'claude agents'
    })

    await runtime.getWorktreePs()

    await expect(runtime.isTerminalRunningAgent(handle)).resolves.toBe(false)
  })
})
