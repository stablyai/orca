import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import { electronMocks } from '../orca-runtime-test-mocks/setup.spec'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  store,
  syncSinglePty
} from './orca-runtime-test-fixtures.spec'

const RESERVED_TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const RESERVED_LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

// A spawn that found the reserved pane already live answers with its owner instead of a new PTY.
const LIVE_PANE_SPAWN = {
  id: 'pty-live',
  stablePaneOwner: { handle: 'term_live', tabId: RESERVED_TAB_ID, leafId: RESERVED_LEAF_ID }
}

function runtimeWithDesktopWindow(spawnResult: Record<string, unknown> = { id: 'pty-launch' }) {
  const requestTabCreate = vi.fn()
  electronMocks.BrowserWindow.fromId.mockReturnValue({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: requestTabCreate }
  })
  const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: RESERVED_TAB_ID })
  const releaseStablePaneCreate = vi.fn()
  const kill = vi.fn(() => true)
  const spawn = vi.fn().mockResolvedValue(spawnResult)
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    claimStablePaneCreate: () => releaseStablePaneCreate,
    spawn,
    write: () => true,
    kill,
    getForegroundProcess: async () => null
  })
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession,
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  return { runtime, spawn, requestTabCreate, revealTerminalSession, releaseStablePaneCreate, kill }
}

describe('OrcaRuntimeService', () => {
  it('bounds retained work for many newline-separated huge ANSI cursor movements', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', '\x1b[4000GZ\n'.repeat(3000), 100)

    const read = await runtime.readTerminal(terminal.handle, { cursor: 0, limit: 2000 })
    expect(read.latestCursor).toBe('3000')
    expect(read.oldestCursor).not.toBe('0')
    expect(read.tail.length).toBeLessThan(100)
    for (const line of read.tail) {
      expect(line.length).toBeLessThanOrEqual(4000)
      expect(line.endsWith('Z')).toBe(true)
      expect(line).not.toContain('4000G')
    }
  })

  it('does not retain split ST-terminated string controls as preview text', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Before \x1b_Gi=31337,s=1,', 100)
    runtime.onPtyData('pty-1', 'v=1,a=q,t=d,f=24;AAAA\x1b\\After\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    const retained = read.tail.join('\n')
    expect(retained).toContain('BeforeAfter')
    expect(retained).not.toContain('Gi=31337')
    expect(retained).not.toContain('AAAA')
  })

  it('refuses a live reserved pane before issuing a handle or revealing it', async () => {
    const { runtime, revealTerminalSession, releaseStablePaneCreate, kill } =
      runtimeWithDesktopWindow(LIVE_PANE_SPAWN)

    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        startupAgent: 'claude',
        tabId: RESERVED_TAB_ID,
        leafId: RESERVED_LEAF_ID,
        requireFreshPane: true,
        presentation: 'focused'
      })
    ).rejects.toThrow('agent_launch_pane_already_live')

    expect((await runtime.listTerminals()).terminals).toEqual([])
    // Refusing reveal also prevents overwriting the running agent's launch config.
    expect(revealTerminalSession).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(releaseStablePaneCreate).toHaveBeenCalled()
  })

  it('still attaches to a live pane when the caller did not require a fresh one', async () => {
    // `terminal.create` keeps its reattach; only agent.launch opts into the refusal.
    const { runtime, revealTerminalSession } = runtimeWithDesktopWindow(LIVE_PANE_SPAWN)
    runtime.registerPty('pty-live', TEST_WORKTREE_ID, null, {
      ...LIVE_PANE_SPAWN.stablePaneOwner,
      terminalHandle: 'term_live'
    })

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      startupAgent: 'claude',
      tabId: RESERVED_TAB_ID,
      leafId: RESERVED_LEAF_ID
    })

    expect(created.isReattach).toBe(true)
    expect((await runtime.listTerminals()).terminals.map((t) => t.handle)).toEqual([created.handle])
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
  })
})
