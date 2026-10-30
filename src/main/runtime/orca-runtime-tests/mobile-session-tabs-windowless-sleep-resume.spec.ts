import { spawnWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import type { SpawnRequestFacts } from '../../../shared/host-spawn-admission'
import {
  createSpawnAdmissionState,
  DEFAULT_SPAWN_ADMISSION_LIMITS,
  decideSpawnAdmission,
  resolveSpawnCharge
} from '../../../shared/host-spawn-admission'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, electronMocks } from '../orca-runtime-test-mocks.spec'
import type { SleepingAgentSessionRecord } from '../orca-runtime-test-mocks.spec'
import {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WINDOW_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../orca-runtime-test-fixtures.spec'
import type { RuntimeStore } from '../runtime-store-contract'

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
// Pane-owned captures must not be resumed twice (#11598).
const PANE_OWNED = { origin: 'worktree-sleep', state: 'done', restoreOnTabOpenOnly: true }

function makeWorkingSleepStore(overrides: Partial<SleepingAgentSessionRecord> = {}) {
  const record: SleepingAgentSessionRecord = {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'provider-session-1' },
    prompt: 'do the thing',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'worktree-sleep',
    ...overrides
  }
  const fixture = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
    })
  )
  const baseSettings = fixture.runtimeStore.getSettings
  // Resume must preserve permissions rather than inherit wider launch defaults.
  fixture.runtimeStore.getSettings = () => ({
    ...baseSettings(),
    agentDefaultArgs: { claude: '--dangerously-skip-permissions' }
  })
  return fixture
}

function withClaudeLaunchedTab(fixture: ReturnType<typeof makeWorkingSleepStore>): void {
  const session = structuredClone(fixture.getSession())
  const tab = session.tabsByWorktree[TEST_WORKTREE_ID]?.[0]
  if (tab) {
    tab.launchAgent = 'claude'
  }
  fixture.setSession(session)
}

function openPane(
  runtimeStore: RuntimeStore,
  windowStatus: 'blocked' | 'openable',
  opts: { spawn?: () => Promise<{ id: string }>; withWindow?: boolean; tap?: boolean } = {}
) {
  const spawn = vi.fn(opts.spawn ?? (() => Promise.resolve({ id: 'persisted-pty' })))
  const runtime = new OrcaRuntimeService(runtimeStore, undefined, {
    getDesktopWindowStatus: () => windowStatus
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  electronMocks.BrowserWindow.fromId.mockReturnValue(null)
  const opened = (async () => {
    if (opts.withWindow) {
      runtime.attachWindow(TEST_WINDOW_ID)
      runtime.markGraphReady(TEST_WINDOW_ID)
      electronMocks.BrowserWindow.fromId.mockReturnValue({ isDestroyed: () => false })
      await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
        notifyClients: false,
        clientKind: 'runtime'
      })
    }
    if (opts.tap === false) {
      return null
    }
    return runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      {
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      }
    )
  })()
  return { opened, spawn, runtime }
}

function spawnedCommand(spawn: ReturnType<typeof vi.fn>, call = 0): string {
  const args: unknown = spawn.mock.calls[call]?.[0]
  return typeof args === 'object' && args !== null && 'command' in args
    ? String(args.command ?? '')
    : ''
}

describe('opening a workspace-slept running agent on a host with no window', () => {
  it('resumes its conversation with only the recorded launch flags', async () => {
    const { runtimeStore } = makeWorkingSleepStore()
    const { opened, spawn } = openPane(runtimeStore, 'blocked')

    await expect(opened).resolves.toMatchObject({ tabs: [{ status: 'ready' }] })
    expect(spawn).toHaveBeenCalledOnce()
    const command = spawnedCommand(spawn)
    expect(command).toContain('--resume')
    expect(command).toContain('provider-session-1')
    expect(command).not.toContain('--dangerously-skip-permissions')
  })

  it('keeps the recorded permission flags of the launch it resumes', async () => {
    const { runtimeStore } = makeWorkingSleepStore({
      launchConfig: { agentArgs: '--permission-mode plan', agentEnv: {} }
    })
    const { opened, spawn } = openPane(runtimeStore, 'blocked')

    await opened
    expect(spawnedCommand(spawn)).toMatch(/--permission-mode'? '?plan/)
  })

  it('still refuses a session another pane also records', async () => {
    const { runtimeStore, getSession, setSession } = makeWorkingSleepStore()
    const session = structuredClone(getSession())
    const own = session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]
    if (own && session.sleepingAgentSessionsByPaneKey) {
      const otherKey = `host-tab:${HEADLESS_SECOND_LEAF_ID}`
      session.sleepingAgentSessionsByPaneKey[otherKey] = { ...own, paneKey: otherKey }
    }
    setSession(session)
    const { opened, spawn } = openPane(runtimeStore, 'blocked')

    await opened
    expect(spawnedCommand(spawn)).not.toContain('provider-session-1')
  })

  it('resumes in the pane on a host that can open a window but has none', async () => {
    const fixture = makeWorkingSleepStore({
      launchConfig: { agentArgs: '--permission-mode plan', agentEnv: {} }
    })
    withClaudeLaunchedTab(fixture)
    const { opened, spawn } = openPane(fixture.runtimeStore, 'openable')

    await opened
    const command = spawnedCommand(spawn)
    expect(command).toContain('--resume')
    expect(command).toContain('provider-session-1')
    expect(command).toMatch(/--permission-mode'? '?plan/)
    expect(command).not.toContain('--dangerously-skip-permissions')
    // Keep the record pane-owned to prevent a second wake; main also marks the resumed agent live.
    await vi.waitFor(() =>
      expect(fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject({
        ...PANE_OWNED,
        ...(ORCA_LAYOUT_OWNER_IS_MAIN ? { origin: 'live' } : {})
      })
    )
  })

  // A restart that loses the PTY still needs the saved resume flags.
  it('still resumes with the recorded flags after a host restart loses the PTY', async () => {
    const fixture = makeWorkingSleepStore({
      launchConfig: { agentArgs: '--permission-mode plan', agentEnv: {} }
    })
    withClaudeLaunchedTab(fixture)
    await openPane(fixture.runtimeStore, 'openable').opened

    const restarted = openPane(fixture.runtimeStore, 'openable')
    await restarted.opened
    const command = spawnedCommand(restarted.spawn)
    expect(command).toContain('provider-session-1')
    expect(command).toMatch(/--permission-mode'? '?plan/)
    expect(command).not.toContain('--dangerously-skip-permissions')
  })

  it('keeps an automatic probe parked while the resume spawn is in flight', async () => {
    const fixture = makeWorkingSleepStore()
    withClaudeLaunchedTab(fixture)
    let landSpawn: (value: { id: string }) => void = () => {}
    let spawnStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => {
      spawnStarted = resolve
    })
    const { opened, spawn, runtime } = openPane(fixture.runtimeStore, 'openable', {
      spawn: () => {
        spawnStarted()
        return new Promise((resolve) => {
          landSpawn = resolve
        })
      }
    })
    await started
    expect(fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject(
      PANE_OWNED
    )

    await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
      notifyClients: false,
      navigation: 'caller',
      intent: 'automatic'
    })
    expect(spawn).toHaveBeenCalledOnce()
    landSpawn({ id: 'persisted-pty' })
    await opened
    expect(spawnedCommand(spawn)).toContain('provider-session-1')
  })

  it('resumes from both of two overlapping opens of the pane, never a plain shell', async () => {
    const fixture = makeWorkingSleepStore()
    withClaudeLaunchedTab(fixture)
    const { opened, spawn, runtime } = openPane(fixture.runtimeStore, 'openable')
    const second = runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      'host-tab',
      HEADLESS_LEAF_ID,
      { notifyClients: false, navigation: 'caller', intent: 'user' }
    )

    await Promise.allSettled([opened, second])
    expect(spawn).toHaveBeenCalled()
    for (let call = 0; call < spawn.mock.calls.length; call += 1) {
      expect(spawnedCommand(spawn, call)).toContain('provider-session-1')
    }
  })

  it('keeps the record for the next open when the pane resume fails to spawn', async () => {
    const fixture = makeWorkingSleepStore()
    const { opened, spawn } = openPane(fixture.runtimeStore, 'openable', {
      spawn: () => Promise.reject(new Error('spawn failed'))
    })

    await expect(opened).rejects.toThrow('spawn failed')
    expect(spawnedCommand(spawn)).toContain('provider-session-1')
    expect(fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject(
      PANE_OWNED
    )
    const retried = openPane(fixture.runtimeStore, 'openable')
    await retried.opened
    expect(spawnedCommand(retried.spawn)).toContain('provider-session-1')
  })

  it('resumes in the pane with a window present too: main is the one executor', async () => {
    const fixture = makeWorkingSleepStore()
    withClaudeLaunchedTab(fixture)
    const { opened, spawn } = openPane(fixture.runtimeStore, 'openable', { withWindow: true })

    await opened
    expect(spawn).toHaveBeenCalledOnce()
    expect(spawnedCommand(spawn)).toContain('provider-session-1')
    expect(fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject(
      PANE_OWNED
    )
  })

  it("resumes on a phone's open of the workspace, and its queued wake ends with the resume", async () => {
    const fixture = makeWorkingSleepStore()
    let landSpawn!: (pty: { id: string }) => void
    const { runtime, spawn } = openPane(fixture.runtimeStore, 'blocked', {
      spawn: () => new Promise((resolve) => (landSpawn = resolve)),
      tap: false
    })
    const resumeSleepingAgents = vi.fn()
    Object.defineProperty(runtime, 'notifier', { value: { resumeSleepingAgents } })

    await runtime.activateManagedWorktree(`id:${TEST_WORKTREE_ID}`, {
      notifyClients: false,
      clientKind: 'mobile'
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    expect(spawnedCommand(spawn)).toContain('provider-session-1')
    expect(resumeSleepingAgents).not.toHaveBeenCalled()
    landSpawn({ id: 'persisted-pty' })
    await vi.waitFor(() => expect(resumeSleepingAgents).toHaveBeenCalledWith(TEST_WORKTREE_ID))
  })

  describe("the window's open of a slept pane (worktrees:resumeSleptPane)", () => {
    const pane = { worktreeId: TEST_WORKTREE_ID, tabId: 'host-tab', leafId: HEADLESS_LEAF_ID }

    it('keeps the original provider and current retry intent through a refused main start', async () => {
      const fixture = makeWorkingSleepStore()
      const { runtime, spawn, opened } = openPane(fixture.runtimeStore, 'openable', {
        withWindow: true,
        tap: false
      })
      await opened
      const limits = DEFAULT_SPAWN_ADMISSION_LIMITS
      const state = createSpawnAdmissionState(limits, 0)
      state.liveAutomatic = limits.maxLiveAutomatic
      spawn.mockImplementation(async (...args: unknown[]) => {
        const request = args[0]
        if (typeof request !== 'object' || request === null || !('spawnIntent' in request)) {
          throw new Error('missing intent')
        }
        const declaredIntent = request.spawnIntent
        if (declaredIntent !== 'user-resume' && declaredIntent !== 'automatic-restore') {
          throw new Error('wrong intent')
        }
        const release = await runtime.acquireWorktreeTerminalSpawn(
          spawnWorktreeTarget(TEST_WORKTREE_ID, null),
          {
            refuseSleptWorktree:
              'refuseSleptWorktree' in request && request.refuseSleptWorktree === true
          }
        )
        try {
          const facts = {
            clientId: 'resume-test',
            declaredIntent,
            hasAgentSessionClaim: false,
            hasHistorySeed: false,
            deadlineAt: 1000
          } satisfies SpawnRequestFacts
          const decision = decideSpawnAdmission({
            state,
            facts,
            charge: resolveSpawnCharge(state, facts, limits, 0),
            pressure: 'ok',
            mode: { kind: 'normal' },
            limits,
            now: 0
          })
          if (spawn.mock.calls.length === 1 || decision.kind === 'defer') {
            throw new Error('terminal_spawn_deferred:live_cap')
          }
          return { id: 'persisted-pty' }
        } finally {
          release()
        }
      })
      await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
      await expect(runtime.resumeSleptPane(pane)).rejects.toThrow(
        'terminal_spawn_deferred:live_cap'
      )
      expect(spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({ spawnIntent: 'user-resume' })
      )
      await expect(runtime.resumeSleptPane(pane, true)).rejects.toThrow(
        'terminal_spawn_deferred:live_cap'
      )
      expect(spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({
          spawnIntent: 'automatic-restore',
          refuseSleptWorktree: true
        })
      )
      await runtime.sleepTerminalsForWorktree(`id:${TEST_WORKTREE_ID}`)
      await expect(runtime.resumeSleptPane(pane, true)).rejects.toThrow(
        'worktree_terminals_sleeping'
      )
      expect(spawn).toHaveBeenCalledTimes(3)
      await expect(runtime.resumeSleptPane(pane, false)).resolves.toBe(true)
      for (let call = 0; call < 4; call += 1) {
        expect(spawnedCommand(spawn, call)).toContain('provider-session-1')
        expect(spawnedCommand(spawn, call)).not.toContain('--dangerously-skip-permissions')
      }
      expect(spawn).toHaveBeenLastCalledWith(
        expect.objectContaining({ spawnIntent: 'user-resume' })
      )
    })

    it('resumes once; a second open after it finished attaches to the same terminal', async () => {
      const fixture = makeWorkingSleepStore()
      const { runtime, spawn, opened } = openPane(fixture.runtimeStore, 'openable', {
        withWindow: true,
        tap: false
      })
      await opened
      await expect(runtime.resumeSleptPane(pane)).resolves.toBe(true)
      expect(spawn).toHaveBeenCalledOnce()
      expect(spawnedCommand(spawn)).toContain('provider-session-1')

      await expect(runtime.resumeSleptPane(pane)).resolves.toBe(true)
      expect(spawn).toHaveBeenCalledOnce()
    })

    it("a reloaded window's open attaches to the terminal main started, never a second resume", async () => {
      const fixture = makeWorkingSleepStore()
      const { runtime, spawn, opened } = openPane(fixture.runtimeStore, 'openable', {
        withWindow: true,
        tap: false
      })
      await opened
      await runtime.resumeSleptPane(pane)
      runtime.attachWindow(TEST_WINDOW_ID)
      runtime.markGraphReady(TEST_WINDOW_ID)
      await expect(runtime.resumeSleptPane(pane)).resolves.toBe(true)
      expect(spawn).toHaveBeenCalledOnce()
      expect(fixture.getSession().sleepingAgentSessionsByPaneKey?.[PANE_KEY]).toMatchObject(
        PANE_OWNED
      )
    })
  })
})
