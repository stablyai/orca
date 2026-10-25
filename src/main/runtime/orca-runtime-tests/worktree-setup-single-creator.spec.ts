import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { WorktreeStartupLaunch } from '../../../shared/worktree/launch-types'
import {
  computeWorktreePathMock,
  createSetupRunnerScript,
  ensurePathWithinWorkspaceMock,
  getEffectiveHooks,
  listWorktrees,
  setRuntimeDesktopSurface,
  shouldRunSetupForCreate
} from '../orca-runtime-test-mocks.spec'
import { makeRuntimeStoreWithWorkspaceSession, store } from '../orca-runtime-test-fixtures.spec'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
import { ProvisioningRuntime } from '../orca-runtime-layout-owner-start-fixture'

const WORKTREE_PATH = '/tmp/workspaces/runtime-setup-all'
const RUNNER = '/tmp/repo/.git/orca/setup-runner.sh'

/** An activated create with a live window, navigating the window and paired clients. */
async function createActivated(options: {
  startup?: WorktreeStartupLaunch
  failAgentSpawn?: boolean
}): Promise<{
  activateWorktree: ReturnType<typeof vi.fn>
  events: RuntimeClientEvent[]
  spawnedCommands: (string | undefined)[]
  runtime: ProvisioningRuntime
  session: () => WorkspaceSessionState
}> {
  // Main's own layout, where a layout-owner build keeps an agent pane that failed to start.
  const mainLayout = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
  const runtime = new ProvisioningRuntime(
    ORCA_LAYOUT_OWNER_IS_MAIN ? mainLayout.runtimeStore : store
  )
  const activateWorktree = vi.fn()
  let spawned = 0
  const spawn = vi.fn(async (args: { command?: string }) => {
    if (options.failAgentSpawn && args.command === options.startup?.command) {
      throw new Error('agent_session_exited_during_start')
    }
    return { id: `pty-${++spawned}` }
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree,
    createTerminal: vi.fn(),
    revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-revealed' }),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  // A live window, so main hands work to it instead of provisioning in the background.
  const liveWindow = { isDestroyed: () => false, webContents: { isDestroyed: () => false } }
  setRuntimeDesktopSurface({
    showNotification: () => false,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create path reads only the window's liveness.
    findWindowById: () => liveWindow as never,
    onIpc: () => {},
    removeIpcListener: () => {}
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  const events: RuntimeClientEvent[] = []
  const unsubscribe = runtime.onClientEvent((event) => events.push(event))

  computeWorktreePathMock.mockReturnValue(WORKTREE_PATH)
  ensurePathWithinWorkspaceMock.mockReturnValue(WORKTREE_PATH)
  vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm worktree:setup' } })
  vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
  vi.mocked(createSetupRunnerScript).mockReturnValue({
    runnerScriptPath: RUNNER,
    envVars: { ORCA_ROOT_PATH: '/tmp/repo', ORCA_WORKTREE_PATH: WORKTREE_PATH }
  })
  vi.mocked(listWorktrees).mockResolvedValue([
    {
      path: WORKTREE_PATH,
      head: 'def',
      branch: 'runtime-setup-all',
      isBare: false,
      isMainWorktree: false
    }
  ])

  try {
    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-setup-all',
      setupDecision: 'run',
      activate: true,
      navigation: 'all',
      ...(options.startup ? { startup: options.startup } : {})
    })
  } finally {
    unsubscribe()
    setRuntimeDesktopSurface(null)
  }
  return {
    activateWorktree,
    events,
    spawnedCommands: spawn.mock.calls.map(([args]) => args.command),
    runtime,
    session: mainLayout.getSession
  }
}

describe('OrcaRuntimeService setup creator', () => {
  it('creates the setup terminal once when an activated create navigates the window and clients', async () => {
    const { activateWorktree, events, spawnedCommands } = await createActivated({})

    const hostHandoffs = activateWorktree.mock.calls.filter((call) => call[2] !== undefined)
    const clientHandoffs = events.filter(
      (event) => event.type === 'activateWorktree' && event.setup !== undefined
    )
    expect({
      hostHandoffs: hostHandoffs.length,
      clientHandoffs: clientHandoffs.length,
      setupSpawns: spawnedCommands.filter((command) => command?.includes(RUNNER)).length
    }).toEqual({ hostHandoffs: 0, clientHandoffs: 0, setupSpawns: 1 })
  })

  it('hands the host window the whole create when the agent fails to start', async () => {
    const startup = { command: 'claude' }
    const { activateWorktree, events, spawnedCommands, runtime, session } = await createActivated({
      startup,
      failAgentSpawn: true
    })

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main keeps the agent's pane to show the failure and still runs setup; the window is handed nothing.
      expect(spawnedCommands).toEqual(['claude', expect.stringContaining(RUNNER)])
      expect(activateWorktree.mock.calls).toEqual([
        ['repo-1', expect.any(String), undefined, undefined, undefined]
      ])
      const [agentRow] = Object.values(session().tabsByWorktree).flat()
      const [agentLeafId] = collectLeafIds(session().terminalLayoutsByTabId[agentRow!.id]?.root)
      expect(runtime.startStatusOf(`${agentRow!.id}:${agentLeafId}`)).toEqual({
        status: 'failed',
        reason: 'agent_session_exited_during_start'
      })
      expect(
        events.filter((event) => event.type === 'activateWorktree' && event.setup !== undefined)
      ).toEqual([])
      return
    }
    // Main provisions nothing, so the window seeds the agent's tab and lays setup out around it.
    expect(spawnedCommands).toEqual(['claude'])
    expect(activateWorktree).toHaveBeenCalledOnce()
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      expect.objectContaining({ runnerScriptPath: RUNNER }),
      expect.objectContaining({ command: 'claude' }),
      undefined
    )
    expect(
      events.filter((event) => event.type === 'activateWorktree' && event.setup !== undefined)
    ).toEqual([])
  })
})
