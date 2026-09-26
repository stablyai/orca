import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

const RESERVED_TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const RESERVED_LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

// A spawn that found the reserved pane already live answers with its owner instead of a new PTY.
const LIVE_PANE_SPAWN = {
  id: 'pty-live',
  stablePaneOwner: { handle: 'term_live', tabId: RESERVED_TAB_ID, leafId: RESERVED_LEAF_ID }
}

function runtimeWithDesktopWindow(spawnResult: Record<string, unknown> = { id: 'pty-launch' }) {
  const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: RESERVED_TAB_ID })
  const releaseStablePaneCreate = vi.fn()
  const kill = vi.fn(() => true)
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    claimStablePaneCreate: () => releaseStablePaneCreate,
    spawn: vi.fn().mockResolvedValue(spawnResult),
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
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  return { runtime, revealTerminalSession, releaseStablePaneCreate, kill }
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

  it('applies ANSI erase-from-start line controls in retained previews', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'ABCDE\x1b[3D\x1b[1KXY\n', 100)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['  XYE'])
    expect(read.tail.join('\n')).not.toContain('ABC')
    expect(read.tail.join('\n')).not.toContain('1K')
  })

  it('applies ANSI stripping for private or intermediate CSI line controls', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'ABCDE\x1b[?99DXY\n', 100)
    runtime.onPtyData('pty-1', 'ABCDE\x1b[1$DXY\n', 101)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['ABCDEXY', 'ABCDEXY'])
    expect(read.tail.join('\n')).not.toContain('?99D')
    expect(read.tail.join('\n')).not.toContain('1$D')
  })

  it('applies ANSI stripping for unsupported erase-line modes', async () => {
    const runtime = new OrcaRuntimeService(store)
    syncSinglePty(runtime)

    const [terminal] = (await runtime.listTerminals()).terminals
    runtime.onPtyData('pty-1', 'Old\x1b[3KNew\n', 100)

    const read = await runtime.readTerminal(terminal.handle)
    expect(read.tail).toEqual(['OldNew'])
    expect(read.tail.join('\n')).not.toContain('3K')
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

  // agent.launch's reserved pane lands here: the host reveal stays the only tab creator, and it
  // must create the tab under the caller's id so the caller's placement lookup can find it.
  it('reveals an agent terminal under the pane the caller reserved', async () => {
    const { runtime, revealTerminalSession } = runtimeWithDesktopWindow()

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      startupAgent: 'claude',
      tabId: RESERVED_TAB_ID,
      leafId: RESERVED_LEAF_ID
    })

    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    expect(revealTerminalSession).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({ tabId: RESERVED_TAB_ID, leafId: RESERVED_LEAF_ID })
    )
    expect(created.paneKey).toBe(`${RESERVED_TAB_ID}:${RESERVED_LEAF_ID}`)
  })

  it('mints its own pane when the reserved leaf is malformed, and reports the one it used', async () => {
    const { runtime, revealTerminalSession } = runtimeWithDesktopWindow()

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      startupAgent: 'claude',
      tabId: RESERVED_TAB_ID,
      leafId: 'not-a-uuid'
    })

    // Still exactly one tab — the caller's reservation lost, and the reported pane says so.
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
    expect(created.tabId).not.toBe(RESERVED_TAB_ID)
    expect(created.paneKey?.startsWith(`${created.tabId}:`)).toBe(true)
  })

  it('refuses a live reserved pane before issuing a handle or revealing it', async () => {
    const { runtime, revealTerminalSession, releaseStablePaneCreate, kill } =
      runtimeWithDesktopWindow(LIVE_PANE_SPAWN)

    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        startupAgent: 'claude',
        tabId: RESERVED_TAB_ID,
        leafId: RESERVED_LEAF_ID,
        requireFreshPane: true
      })
    ).rejects.toThrow('agent_launch_pane_already_live')

    // Nothing registered, so no handle was issued for the live PTY.
    expect((await runtime.listTerminals()).terminals).toEqual([])
    // No reveal means no renderer launch-config re-registration over the running agent's.
    expect(revealTerminalSession).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
    expect(releaseStablePaneCreate).toHaveBeenCalled()
  })

  it('still attaches to a live pane when the caller did not require a fresh one', async () => {
    // `terminal.create` keeps its reattach; only agent.launch opts into the refusal.
    const { runtime, revealTerminalSession } = runtimeWithDesktopWindow(LIVE_PANE_SPAWN)

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      startupAgent: 'claude',
      tabId: RESERVED_TAB_ID,
      leafId: RESERVED_LEAF_ID
    })

    expect(created.isReattach).toBe(true)
    expect((await runtime.listTerminals()).terminals.map((t) => t.handle)).toEqual([created.handle])
    expect(revealTerminalSession).toHaveBeenCalledTimes(1)
  })

  // agent.launch now hands a terminal launch its session picks; this is where they must reach argv.
  it('starts an agent terminal with the model the caller picked', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-picked' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      startupAgent: 'claude',
      launchPreferences: { model: 'opus' }
    })

    expect(spawn.mock.calls[0]?.[0]?.command).toMatch(/'--model' 'opus'/)
  })

  it('starts an agent terminal without a model flag when no pick was made', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-default' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { startupAgent: 'claude' })

    expect(spawn.mock.calls[0]?.[0]?.command).not.toMatch(/--model/)
  })
})
