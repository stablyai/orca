import { describe, expect, it, vi } from 'vitest'
import '../../orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../orca-runtime-tests/orca-runtime-test-lifecycle.spec'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  store,
  syncSinglePty
} from '../../orca-runtime-tests/orca-runtime-test-fixtures.spec'
import { registerBoundPty } from '../../orca-runtime-tests/bind-first-pane.test-fixture'

async function psStatus(runtime: OrcaRuntimeService): Promise<string | undefined> {
  return (await runtime.getWorktreePs()).worktrees.find((w) => w.worktreeId === TEST_WORKTREE_ID)
    ?.status
}

// Display must reflect stale-title clears while runtime retains native titles as evidence; these titles are synthetic.
describe('display surfaces after the stale-working title clear', () => {
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
      const runtime = new OrcaRuntimeService({ ...store })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      const register = () =>
        registerBoundPty(runtime, sshPtyId, TEST_WORKTREE_ID, 'conn-1', {
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
      await runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
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

  // Synthetic: prompt verification behind a standing clear judges against the baseline main had.
})
