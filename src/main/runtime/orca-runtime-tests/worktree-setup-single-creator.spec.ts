import { describe, expect, it, vi } from 'vitest'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { WorktreeStartupLaunch } from '../../../shared/worktree/launch-types'
import {
  OrcaRuntimeService,
  computeWorktreePathMock,
  createSetupRunnerScript,
  ensurePathWithinWorkspaceMock,
  getEffectiveHooks,
  listWorktrees,
  setRuntimeDesktopSurface,
  shouldRunSetupForCreate
} from '../orca-runtime-test-mocks.spec'
import { store } from '../orca-runtime-test-fixtures.spec'

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
}> {
  const runtime = new OrcaRuntimeService(store)
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
    sleepWorktree: vi.fn(),
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
    spawnedCommands: spawn.mock.calls.map(([args]) => args.command)
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
    const { activateWorktree, events, spawnedCommands } = await createActivated({
      startup,
      failAgentSpawn: true
    })

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
