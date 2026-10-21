import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import './orca-runtime-test-lifecycle.spec'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  store,
  syncSinglePty
} from './orca-runtime-test-fixtures.spec'

async function psStatus(runtime: OrcaRuntimeService): Promise<string | undefined> {
  return (await runtime.getWorktreePs()).worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
    ?.status
}

// Synthetic titles: display surfaces must show what the tab shows once the stale-working timer
// clears a title, although the runtime keeps the agent's own title as evidence.
describe('display surfaces after the stale-working title clear', () => {
  it('worktree ps and the phone show the cleared status for a terminal with no renderer pane', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'bg-pty' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        mobileSessionTabs: [
          {
            worktree: TEST_WORKTREE_ID,
            publicationEpoch: 'renderer-empty',
            snapshotVersion: 1,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null,
            tabs: []
          }
        ]
      })
      const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: 'codex',
        tabId: 'bg-tab',
        leafId: HEADLESS_LEAF_ID
      })
      const psStatus = async () =>
        (await runtime.getWorktreePs()).worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
          ?.status
      const phoneTabs = async () =>
        (await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs.map((tab) => ({
          title: 'title' in tab ? tab.title : undefined,
          state: 'agentStatus' in tab ? tab.agentStatus?.state : undefined
        }))
      runtime.onPtyData('bg-pty', '\x1b]0;Codex working\x07', Date.now())
      runtime.onPtyData('bg-pty', 'output without a title\r\n', Date.now())
      expect(await psStatus()).toBe('working')
      expect(await phoneTabs()).toEqual([{ title: 'Codex working', state: 'working' }])

      await vi.advanceTimersByTimeAsync(3_000)

      expect(await psStatus()).toBe('active')
      expect(await phoneTabs()).toEqual([{ title: 'Codex', state: 'done' }])
      const listed = (await runtime.listTerminals()).terminals.find(
        (candidate) => candidate.handle === terminal.handle
      )
      expect(listed?.title).toBe('Codex')

      // The agent's next genuine title retires the clear.
      runtime.onPtyData('bg-pty', '\x1b]0;Codex working\x07', Date.now())
      expect(await psStatus()).toBe('working')
      expect(await phoneTabs()).toEqual([{ title: 'Codex working', state: 'working' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a reattach restore seed does not bring the cleared working status back', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'codex'
      })
      syncSinglePty(runtime, 'pty-1', { paneTitle: 'Codex working' })
      runtime.onPtyData('pty-1', '\x1b]0;Codex working\x07', Date.now())
      runtime.onPtyData('pty-1', 'output without a title\r\n', Date.now())
      await vi.advanceTimersByTimeAsync(3_000)
      // The renderer applies the cleared fact and republishes its pane title.
      syncSinglePty(runtime, 'pty-1', { paneTitle: 'Codex' })
      const psStatus = async () =>
        (await runtime.getWorktreePs()).worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
          ?.status
      expect(await psStatus()).toBe('active')
      // A renderer reload reattaches with the daemon's last title, as the spawn RPC path does.
      runtime.seedTerminalRestoreTail('pty-1', { lastTitle: 'Codex working' })
      syncSinglePty(runtime, 'pty-1', { paneTitle: 'Codex' })
      expect(await psStatus()).toBe('active')
    } finally {
      vi.useRealTimers()
    }
  })

  it('an SSH relay drop and same-incarnation reattach keep the cleared display', async () => {
    vi.useFakeTimers()
    try {
      const sshPtyId = 'ssh:conn-1@@relay-9'
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      const register = () =>
        runtime.registerPty(sshPtyId, TEST_WORKTREE_ID, 'conn-1', {
          tabId: 'tab-1',
          leafId: HEADLESS_LEAF_ID,
          incarnationId: 'inc-1'
        })
      register()
      runtime.onPtyData(sshPtyId, '\x1b]0;Codex working\x07', Date.now())
      runtime.onPtyData(sshPtyId, 'output without a title\r\n', Date.now())
      await vi.advanceTimersByTimeAsync(3_000)
      expect(await psStatus(runtime)).toBe('active')
      // An abnormal relay exit keeps the record for the reconnect grace; the relay reattaches.
      runtime.onPtyExit(sshPtyId, -1)
      register()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await psStatus(runtime)).toBe('active')
      expect((await runtime.listTerminals()).terminals.map((t) => t.title)).toEqual(['Codex'])
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['⠋ Codex working', '⠋ repo'])(
    'an agent that exits behind %s loses its foreground identity',
    async (spinner) => {
      vi.useFakeTimers()
      try {
        let foreground: string | null = 'codex'
        const runtime = new OrcaRuntimeService(store)
        runtime.setPtyController({
          write: () => true,
          kill: () => true,
          getForegroundProcess: async () => foreground
        })
        syncSinglePty(runtime, 'pty-1', { paneTitle: null, tabTitle: 'Terminal' })
        runtime.onPtyData('pty-1', '\x1b]0;Codex ready\x07', Date.now())
        runtime.onPtyData('pty-1', `\x1b]0;${spinner}\x07`, Date.now())
        await vi.advanceTimersByTimeAsync(100)
        const identity = async () =>
          (await runtime.listTerminals()).terminals[0]?.agentIdentity ?? null
        expect(await identity()).not.toBeNull()
        foreground = 'zsh'
        runtime.onPtyData('pty-1', '\x1b]133;D;0\x07\x1b]133;A\x07% ', Date.now())
        await vi.advanceTimersByTimeAsync(3_500)
        expect(await identity()).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('a renderer pane title older than the clear cannot prove presence', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'zsh'
      })
      syncSinglePty(runtime, 'pty-1', { paneTitle: null })
      runtime.onPtyData('pty-1', '\x1b]0;⠋ repo\x07', Date.now())
      // The renderer republishes the spinner after main recorded it, and has not echoed the clear.
      syncSinglePty(runtime, 'pty-1', { paneTitle: '⠋ repo' })
      runtime.onPtyData('pty-1', '\x1b]133;D;0\x07\x1b]133;A\x07% ', Date.now())
      await vi.advanceTimersByTimeAsync(3_000)
      const handle = (await runtime.listTerminals()).terminals[0]?.handle ?? ''
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        isRunningAgent: false,
        status: null
      })
      await expect(
        runtime.isTerminalRunningAgent(handle, { retryForegroundWrappers: false })
      ).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a live agent with an unrecognized process keeps presence through its cleared name title', async () => {
    vi.useFakeTimers()
    try {
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'bg-pty' }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => 'Python'
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        tabId: 'bg-tab',
        leafId: HEADLESS_LEAF_ID
      })
      runtime.onPtyData('bg-pty', '\x1b]0;⠋ Claude Code\x07', Date.now())
      runtime.onPtyData('bg-pty', 'output without a title\r\n', Date.now())
      await vi.advanceTimersByTimeAsync(3_000)
      // Main read the cleared `Claude Code`, which names an agent, so a live wrapper-run agent stays found.
      await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toMatchObject({
        isRunningAgent: true,
        status: 'idle'
      })
      await expect(
        runtime.isTerminalRunningAgent(terminal.handle, { retryForegroundWrappers: false })
      ).resolves.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // Synthetic: a trust dialog painted after the clear, behind the name title `⠋ Claude Code`.
  it.each(['mounted', 'mountedEcho', 'rendererless'] as const)(
    'a trust dialog painted after the clear still reads as a wait on the user (%s)',
    async (mode) => {
      vi.useFakeTimers()
      try {
        const ptyId = mode === 'rendererless' ? 'bg-pty' : 'pty-1'
        const runtime = new OrcaRuntimeService(store)
        runtime.setPtyController({
          spawn: vi.fn().mockResolvedValue({ id: ptyId }),
          write: () => true,
          kill: () => true,
          getForegroundProcess: async () => 'claude'
        })
        let handle: string
        if (mode === 'rendererless') {
          runtime.attachWindow(1)
          runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
          handle = (
            await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
              tabId: 'bg-tab',
              leafId: HEADLESS_LEAF_ID
            })
          ).handle
        } else {
          syncSinglePty(runtime, ptyId, { tabTitle: 'Terminal 1', paneTitle: null })
          runtime.onPtyData(ptyId, 'boot\r\n', Date.now())
          handle = (await runtime.listTerminals()).terminals[0]?.handle ?? ''
        }
        runtime.onPtyData(ptyId, '\x1b]0;⠋ Claude Code\x07', Date.now())
        if (mode !== 'rendererless') {
          syncSinglePty(runtime, ptyId, { tabTitle: '⠋ Claude Code', paneTitle: '⠋ Claude Code' })
        }
        runtime.onPtyData(ptyId, 'still running\r\n', Date.now())
        await vi.advanceTimersByTimeAsync(3_000)
        if (mode === 'mountedEcho') {
          // The renderer republishes its own cleared title, as a mounted pane does.
          syncSinglePty(runtime, ptyId, { tabTitle: 'Claude Code', paneTitle: 'Claude Code' })
        }
        await vi.advanceTimersByTimeAsync(1_000)
        runtime.onPtyData(
          ptyId,
          '\r\nDo you trust the files in this folder?\r\n /repo/app\r\n 1. Yes, proceed\r\n 2. No, exit\r\n',
          Date.now()
        )
        await vi.advanceTimersByTimeAsync(1_000)
        await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
          isRunningAgent: true,
          status: 'permission'
        })
        await expect(
          assertTerminalAgentSendable({ runtime, handle, assertWritable: () => {} })
        ).rejects.toThrow('terminal_guard_permission')
        await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
          source: 'prompt-text',
          reason: 'agent-trust-workspace'
        })
      } finally {
        vi.useRealTimers()
      }
    }
  )

  // Synthetic: prompt verification behind a standing clear judges against the baseline main had.
  it.each([
    ['mounted', 'output only', false],
    ['mountedEcho', 'output only', false],
    ['rendererless', 'output only', false],
    ['mounted', 'a new spinner frame', true],
    ['mountedEcho', 'a new spinner frame', true],
    ['rendererless', 'a new spinner frame', true]
  ] as const)(
    'a prompt sent behind a cleared spinner (%s) answered by %s settles as on main',
    async (mode, _after, spinnerFrame) => {
      vi.useFakeTimers()
      try {
        const ptyId = mode === 'rendererless' ? 'bg-pty' : 'pty-1'
        const runtime = new OrcaRuntimeService(store)
        runtime.setPtyController({
          spawn: vi.fn().mockResolvedValue({ id: ptyId }),
          write: (_ptyId, data) => {
            if (data === '\r') {
              runtime.onPtyData(
                ptyId,
                spinnerFrame ? '\x1b]0;⠙ Claude Code\x07' : '\r\n',
                Date.now()
              )
            }
            return true
          },
          kill: () => true,
          getForegroundProcess: async () => 'claude'
        })
        let handle: string
        if (mode === 'rendererless') {
          runtime.attachWindow(1)
          runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
          handle = (
            await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
              tabId: 'bg-tab',
              leafId: HEADLESS_LEAF_ID
            })
          ).handle
        } else {
          syncSinglePty(runtime, ptyId, { tabTitle: 'Terminal 1', paneTitle: null })
          runtime.onPtyData(ptyId, 'boot\r\n', Date.now())
          handle = (await runtime.listTerminals()).terminals[0]?.handle ?? ''
        }
        runtime.onPtyData(ptyId, '\x1b]0;⠋ Claude Code\x07', Date.now())
        if (mode !== 'rendererless') {
          syncSinglePty(runtime, ptyId, { tabTitle: '⠋ Claude Code', paneTitle: '⠋ Claude Code' })
        }
        runtime.onPtyData(ptyId, 'still running\r\n', Date.now())
        await vi.advanceTimersByTimeAsync(3_000)
        if (mode === 'mountedEcho') {
          syncSinglePty(runtime, ptyId, { tabTitle: 'Claude Code', paneTitle: 'Claude Code' })
        }
        if (spinnerFrame) {
          // The receipt path takes no output as evidence, so only a new turn settles it.
          const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
            inputKind: 'driving',
            acceptQueued: true,
            requestId: `after-clear-${mode}`
          })
          await vi.advanceTimersByTimeAsync(20_000)
          await expect(submission).resolves.toMatchObject({
            prompt: { stages: ['input_accepted', 'turn_started'] }
          })
        } else {
          // Output after Enter is not a turn start, so a swallowed Enter still reads as stalled.
          const submission = runtime.sendTerminalAgentPrompt(handle, 'review this', {
            inputKind: 'driving'
          })
          const rejected = expect(submission).rejects.toThrow('agent_prompt_stalled')
          // Past the 30 s effect window.
          await vi.advanceTimersByTimeAsync(40_000)
          await rejected
        }
      } finally {
        vi.useRealTimers()
      }
    }
  )
})
