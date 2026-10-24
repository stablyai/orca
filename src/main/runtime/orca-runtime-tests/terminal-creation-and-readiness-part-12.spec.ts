import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, electronMocks } from '../orca-runtime-test-mocks.spec'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'
import { agentLaunchSurfaceFactory } from '../rpc/methods/agent-launch-surfaces'
import { publishAgentLaunchTabEarly } from '../rpc/methods/agent-launch-tab-publication'
import { AgentLaunch } from '../../../shared/rpc-contract/agent-launch-params'
import { DESKTOP_RPC_CALLER } from '../rpc/rpc-caller-identity'
import type { RpcContext } from '../rpc/core'
import type { AgentLaunchTabPublished } from '../../../shared/agent-launch-tab-publication'

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

  it.each(['focused', 'background'] as const)(
    'keeps a fresh %s pane host-owned when a desktop window is available',
    async (presentation) => {
      const { runtime, spawn, requestTabCreate, revealTerminalSession } = runtimeWithDesktopWindow()

      const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        startupAgent: 'claude',
        tabId: RESERVED_TAB_ID,
        leafId: RESERVED_LEAF_ID,
        requireFreshPane: true,
        presentation
      })

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ tabId: RESERVED_TAB_ID, leafId: RESERVED_LEAF_ID })
      )
      expect(created.paneKey).toBe(`${RESERVED_TAB_ID}:${RESERVED_LEAF_ID}`)
      expect(requestTabCreate).not.toHaveBeenCalled()
      if (presentation === 'focused') {
        expect(revealTerminalSession).toHaveBeenCalledExactlyOnceWith(
          TEST_WORKTREE_ID,
          expect.objectContaining({
            tabId: RESERVED_TAB_ID,
            leafId: RESERVED_LEAF_ID,
            presentation,
            activate: true
          })
        )
      } else {
        expect(revealTerminalSession).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['pending', 'completed', 'failed'] as const)(
    'keeps desktop publication %s separate from the reserved host spawn',
    async (phase) => {
      const { runtime, spawn, requestTabCreate, revealTerminalSession } = runtimeWithDesktopWindow()
      let publish!: (reply: AgentLaunchTabPublished) => void
      const publishing = new Promise<AgentLaunchTabPublished>((resolve) => {
        publish = resolve
      })
      vi.spyOn(runtime, 'canPublishAgentLaunchTab').mockReturnValue(true)
      vi.spyOn(runtime, 'publishAgentLaunchTab').mockReturnValue(
        phase === 'failed' ? Promise.reject(new Error('renderer_unavailable')) : publishing
      )
      const context: RpcContext = { runtime, caller: DESKTOP_RPC_CALLER, clientKind: 'runtime' }
      const early = await publishAgentLaunchTabEarly(
        AgentLaunch.parse({
          agent: 'claude',
          target: { kind: 'existing', worktree: `id:${TEST_WORKTREE_ID}` },
          paneKey: `${RESERVED_TAB_ID}:${RESERVED_LEAF_ID}`,
          presentation: 'focused'
        }),
        context
      )
      expect(early).not.toBeNull()
      const reply = { tabId: RESERVED_TAB_ID, created: true, placement: { groupId: 'group-1' } }
      if (phase === 'completed') {
        publish(reply)
        await publishing
      }
      const surface = await agentLaunchSurfaceFactory(
        context,
        undefined,
        undefined,
        false,
        undefined,
        { early, presentation: 'focused' }
      ).createTerminalAgent({
        worktreeId: TEST_WORKTREE_ID,
        agent: 'claude',
        paneKey: `${RESERVED_TAB_ID}:${RESERVED_LEAF_ID}`,
        startupPrompt: 'fix the build'
      })
      expect(surface.paneKey).toBe(`${RESERVED_TAB_ID}:${RESERVED_LEAF_ID}`)
      expect(requestTabCreate).not.toHaveBeenCalled()
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          tabId: RESERVED_TAB_ID,
          leafId: RESERVED_LEAF_ID
        })
      )
      expect(spawn.mock.calls[0]?.[0]?.command).toContain('fix the build')
      expect(revealTerminalSession).toHaveBeenCalledExactlyOnceWith(
        TEST_WORKTREE_ID,
        expect.objectContaining({
          tabId: RESERVED_TAB_ID,
          leafId: RESERVED_LEAF_ID,
          activate: false,
          surfaceOwner: false,
          agentLaunchViewer: phase === 'failed' ? 'focus-in-workspace' : 'none'
        })
      )
      expect(runtime.publishAgentLaunchTab).toHaveBeenCalledWith(
        expect.objectContaining({ viewer: 'focus-in-workspace' })
      )
      if (phase === 'pending') {
        publish(reply)
      }
      early?.surfacePublished({
        worktreeId: TEST_WORKTREE_ID,
        outcome: { kind: 'terminal', ...surface },
        receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'test' }
      })
      early?.finish()
    }
  )

  it.each([
    { desktop: false, viewer: 'focus-window' },
    { desktop: true, viewer: 'focus-in-workspace' }
  ])('rechecks failed publication during the $viewer host spawn', async ({ desktop, viewer }) => {
    const { runtime, spawn, requestTabCreate, revealTerminalSession } = runtimeWithDesktopWindow()
    const publishing = Promise.withResolvers<AgentLaunchTabPublished>()
    const spawning = Promise.withResolvers<{ id: string }>()
    const started = Promise.withResolvers<void>()
    spawn.mockImplementation(() => {
      started.resolve()
      return spawning.promise
    })
    vi.spyOn(runtime, 'canPublishAgentLaunchTab').mockReturnValue(true)
    vi.spyOn(runtime, 'publishAgentLaunchTab').mockReturnValue(publishing.promise)
    const context: RpcContext = {
      runtime,
      ...(desktop ? { caller: DESKTOP_RPC_CALLER, clientKind: 'runtime' as const } : {})
    }
    const paneKey = `${RESERVED_TAB_ID}:${RESERVED_LEAF_ID}`
    const early = await publishAgentLaunchTabEarly(
      AgentLaunch.parse({
        agent: 'claude',
        target: { kind: 'existing', worktree: `id:${TEST_WORKTREE_ID}` },
        paneKey,
        presentation: 'focused'
      }),
      context
    )
    expect(early?.windowOwnsPresentation()).toBe(true)
    const creating = agentLaunchSurfaceFactory(context, undefined, undefined, false, undefined, {
      early,
      presentation: 'focused'
    }).createTerminalAgent({
      worktreeId: TEST_WORKTREE_ID,
      agent: 'claude',
      paneKey,
      startupPrompt: 'fix the build'
    })
    await started.promise
    publishing.reject(new Error('agent_launch_tab_publish_timeout'))
    await Promise.resolve()
    expect(early?.windowOwnsPresentation()).toBe(false)
    spawning.resolve({ id: 'pty-launch' })
    const terminal = await creating
    expect(terminal.paneKey).toBe(paneKey)
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]?.command).toContain('fix the build')
    expect(requestTabCreate).not.toHaveBeenCalled()
    expect(revealTerminalSession).toHaveBeenCalledExactlyOnceWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({
        tabId: RESERVED_TAB_ID,
        leafId: RESERVED_LEAF_ID,
        agentLaunchViewer: viewer,
        activate: false,
        surfaceOwner: false
      })
    )
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
        requireFreshPane: true,
        presentation: 'focused'
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

  // Every agent the runtime builds is attributed, so a launch whose caller named no surface still
  // counts; only the caller's surface is taken, the rest is derived from the agent it resolved.
  it.each([
    ['orchestration', 'orchestration'],
    [undefined, 'unknown'],
    ['a_surface_added_later', 'unknown']
  ])('attributes a startup-agent launch named %s as %s', async (launchSource, expected) => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-attributed' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      startupAgent: 'claude',
      ...(launchSource ? { launchSource } : {})
    })

    expect(spawn.mock.calls[0]?.[0]?.telemetry).toEqual({
      agent_kind: 'claude-code',
      launch_source: expected,
      request_kind: 'new'
    })
  })

  it('attributes a fresh agent session the host builds as unknown', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-session' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createAgentSession(
      {
        clientOperationId: `${Date.now()}-${'cd'.repeat(16)}`,
        worktree: `id:${TEST_WORKTREE_ID}`,
        agent: 'claude'
      },
      { clientId: 'remote-desktop', clientKind: 'runtime' }
    )

    expect(spawn.mock.calls[0]?.[0]?.telemetry).toEqual({
      agent_kind: 'claude-code',
      launch_source: 'unknown',
      request_kind: 'new'
    })
  })

  it('leaves a bare agent command the user typed out of launch attribution', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bare' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, { command: 'claude' })

    expect(spawn.mock.calls[0]?.[0]?.launchAgent).toBe('claude')
    expect(spawn.mock.calls[0]?.[0]?.telemetry).toBeUndefined()
  })
})
