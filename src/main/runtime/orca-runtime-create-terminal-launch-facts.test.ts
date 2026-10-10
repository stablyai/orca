/**
 * What the host lane hands `ptyController.spawn` when `createTerminal` plans an agent itself
 * (`startupAgent`): agent.launch (row 3) and orchestration workers (row 10).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  expectedOrcaEnvKeys,
  hostLane,
  internalsOf,
  LEAF_ID,
  orcaEnvKeys,
  PANE_KEY,
  pickSpawnFacts,
  POSIX_PATH,
  setPlatform,
  spawnArgs,
  spawnEnv,
  TAB_ID,
  WIN_PATH,
  workspaceScope,
  WSL_PATH,
  type WorkspaceKind
} from './orca-runtime-host-lane-spawn-test-fixture'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const ORIGINAL_PLATFORM = process.platform

type HostPlatform = 'darwin' | 'linux' | 'win32'

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM)
  vi.restoreAllMocks()
})

// The options rpc/methods/agent-launch-surfaces.ts createTerminalAgent passes for a reserved pane.
function agentLaunchOptions(extra: TerminalCreateOptions = {}): TerminalCreateOptions {
  return {
    startupAgent: 'claude',
    tabId: TAB_ID,
    leafId: LEAF_ID,
    requireFreshPane: true,
    launchSource: 'cli',
    viewMode: 'terminal',
    surfaceOwner: false,
    ...extra
  }
}

// Quoting platform per case: repo -> project runtime (none here) else process.platform; folder
// -> \\wsl$ means linux; SSH -> Windows-absolute path means win32 (PowerShell-style) else linux.
const CMD = 'claude "--dangerously-skip-permissions"'
const POSIX = "claude '--dangerously-skip-permissions'"

type MatrixRow = {
  os: HostPlatform
  kind: WorkspaceKind
  connectionId: string | null
  path: string
  command: string
}

// Local C:\ and \\wsl$ exist only on a Windows host; a posix path on a local Windows host is not a
// workspace a user can have, so those combinations are dropped.
const MATRIX: MatrixRow[] = [
  ...(['darwin', 'linux'] as const).flatMap((os) =>
    (['repo', 'folder'] as const).map((kind) => ({
      os,
      kind,
      connectionId: null,
      path: POSIX_PATH,
      command: POSIX
    }))
  ),
  { os: 'win32', kind: 'repo', connectionId: null, path: WIN_PATH, command: CMD },
  { os: 'win32', kind: 'folder', connectionId: null, path: WIN_PATH, command: CMD },
  // main today: a local repo at \\wsl$ with no WSL project runtime quotes for the Windows shell.
  { os: 'win32', kind: 'repo', connectionId: null, path: WSL_PATH, command: CMD },
  { os: 'win32', kind: 'folder', connectionId: null, path: WSL_PATH, command: POSIX },
  ...(['darwin', 'linux', 'win32'] as const).flatMap((os) =>
    (['repo', 'folder'] as const).flatMap((kind) =>
      [POSIX_PATH, WIN_PATH].map((path) => ({
        os,
        kind,
        connectionId: 'ssh-1',
        path,
        // A remote host never takes the local terminalWindowsShell, so this arg stays single-quoted.
        command: POSIX
      }))
    )
  )
]

// Pins main's current launch behaviour as the convergence parity baseline (row 3, host half): the spawn request agent.launch's createTerminal options produce.
describe('agent.launch startupAgent create -> ptyController.spawn', () => {
  it.each(MATRIX)(
    '$os $kind connection=$connectionId at $path',
    async ({ os, kind, connectionId, path, command }) => {
      setPlatform(os)
      const scope = workspaceScope(kind, path, connectionId)
      const { runtime, spawn } = hostLane(scope)

      await runtime.createTerminal(`id:${scope.id}`, agentLaunchOptions())

      const args = spawnArgs(spawn)
      expect(pickSpawnFacts(args)).toStrictEqual({
        command,
        cols: 120,
        rows: 40,
        initiallyHidden: true,
        persistHostSessionBinding: true,
        placement: { kind: 'new-tab' },
        commandDelivery: 'provider',
        startupCommandDelivery: undefined,
        cwd: path,
        connectionId,
        launchAgent: 'claude',
        telemetry: { agent_kind: 'claude-code', launch_source: 'cli', request_kind: 'new' }
      })
      expect(args).not.toHaveProperty('shellOverride')
      expect(args.tabId).toBe(TAB_ID)
      expect(args.leafId).toBe(LEAF_ID)
      expect(args.preAllocatedHandle).toMatch(/^term_/)
      expect(orcaEnvKeys(spawn)).toEqual(expectedOrcaEnvKeys(kind))
      const env = spawnEnv(spawn)
      expect(env.ORCA_PANE_KEY).toBe(PANE_KEY)
      expect(env.ORCA_TAB_ID).toBe(TAB_ID)
      expect(env.ORCA_WORKTREE_ID).toBe(scope.id)
      // The jcode dir is a local unix-socket path: local non-Windows hosts only.
      expect('JCODE_RUNTIME_DIR' in env).toBe(connectionId === null && os !== 'win32')
    }
  )

  it.each([
    {
      os: 'darwin' as const,
      connectionId: null,
      path: POSIX_PATH,
      command: `codex '--dangerously-bypass-approvals-and-sandbox' 'fix Bob'"'"'s branch'`
    },
    {
      os: 'win32' as const,
      connectionId: null,
      path: WIN_PATH,
      command: 'codex "--dangerously-bypass-approvals-and-sandbox" "fix Bob\'s branch"'
    },
    {
      os: 'linux' as const,
      connectionId: 'ssh-1',
      path: WIN_PATH,
      command: "codex '--dangerously-bypass-approvals-and-sandbox' 'fix Bob''s branch'"
    }
  ])(
    'carries a codex prompt with shell-ready delivery ($os, connection=$connectionId)',
    async ({ os, connectionId, path, command }) => {
      setPlatform(os)
      const scope = workspaceScope('repo', path, connectionId)
      const { runtime, spawn } = hostLane(scope)
      const onStartupPromptCarry = vi.fn()

      await runtime.createTerminal(
        `id:${scope.id}`,
        agentLaunchOptions({
          startupAgent: 'codex',
          startupPrompt: "fix Bob's branch",
          onStartupPromptCarry
        })
      )

      expect(pickSpawnFacts(spawnArgs(spawn))).toStrictEqual({
        command,
        cols: 120,
        rows: 40,
        initiallyHidden: true,
        persistHostSessionBinding: true,
        placement: { kind: 'new-tab' },
        commandDelivery: 'provider',
        startupCommandDelivery: 'shell-ready',
        cwd: path,
        connectionId,
        launchAgent: 'codex',
        telemetry: { agent_kind: 'codex', launch_source: 'cli', request_kind: 'new' }
      })
      expect(onStartupPromptCarry).toHaveBeenCalledWith(true)
    }
  )

  it('reveals with surfaceOwner false and no presentation, and publishes a phone tab titled Terminal', async () => {
    setPlatform('darwin')
    const scope = workspaceScope('repo', POSIX_PATH, null)
    const { runtime, reveal } = hostLane(scope)
    const onPtySpawnDispatched = vi.fn()

    const created = await runtime.createTerminal(
      `id:${scope.id}`,
      agentLaunchOptions({ onPtySpawnDispatched })
    )

    // main today: the resume config's agentCommand already carries the quoted default args.
    const launchConfig = {
      agentCommand: "claude '--dangerously-skip-permissions'",
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    }
    expect(onPtySpawnDispatched).toHaveBeenCalledWith({ launchConfig, launchAgent: 'claude' })

    expect(reveal).toHaveBeenCalledTimes(1)
    expect(reveal.mock.calls[0]?.[0]).toBe(scope.id)
    expect(reveal.mock.calls[0]?.[1]).toStrictEqual({
      ptyId: 'pty-1',
      title: null,
      launchConfig,
      launchToken: expect.any(String),
      launchAgent: 'claude',
      viewMode: 'terminal',
      activate: false,
      surfaceOwner: false,
      tabId: TAB_ID,
      leafId: LEAF_ID
    })
    expect(created).toMatchObject({ paneKey: PANE_KEY, title: null, surface: 'visible' })
    const snapshot = internalsOf(runtime).mobileSessionTabsByWorktree.get(scope.id)
    // main today: an untitled agent launch reaches the phone as the literal 'Terminal'.
    expect(snapshot?.tabs).toStrictEqual([
      {
        type: 'terminal',
        id: `${TAB_ID}::${LEAF_ID}`,
        parentTabId: TAB_ID,
        leafId: LEAF_ID,
        ptyId: 'pty-1',
        incarnationId: null,
        title: 'Terminal',
        launchAgent: 'claude',
        viewMode: 'terminal',
        parentLayout: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        },
        isActive: true
      }
    ])
    expect(snapshot?.activeTabId).toBe(`${TAB_ID}::${LEAF_ID}`)
  })

  it('refuses a disabled startupAgent with the exact host message and spawns nothing', async () => {
    setPlatform('darwin')
    const scope = workspaceScope('repo', POSIX_PATH, null)
    const { runtime, spawn } = hostLane(scope, { disabledTuiAgents: ['claude'] })

    await expect(runtime.createTerminal(`id:${scope.id}`, agentLaunchOptions())).rejects.toThrow(
      new Error('Agent claude is disabled. Choose an enabled agent.')
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('passes a missing worktree subdirectory cwd through unchanged (no root fallback)', async () => {
    setPlatform('darwin')
    const scope = workspaceScope('repo', '/definitely/missing/wt', null)
    const { runtime, spawn } = hostLane(scope)

    await runtime.createTerminal(
      `id:${scope.id}`,
      agentLaunchOptions({ cwd: 'packages/deleted-subdir' })
    )

    // main today: the window lane falls back to the root; the host lane hands the provider the gone path.
    expect(spawnArgs(spawn).cwd).toBe('/definitely/missing/wt/packages/deleted-subdir')
  })
})

// Pins main's current launch behaviour as the convergence parity baseline (row 10, workers): an existing-worktree orchestration worker's spawn, reveal and phone title.
describe('orchestration worker startupAgent create -> ptyController.spawn', () => {
  it.each([
    { kind: 'repo' as const, connectionId: null },
    { kind: 'folder' as const, connectionId: null },
    { kind: 'repo' as const, connectionId: 'ssh-1' }
  ])(
    'spawns worker-<id> as an orchestration launch ($kind, connection=$connectionId)',
    async ({ kind, connectionId }) => {
      setPlatform('linux')
      const scope = workspaceScope(kind, POSIX_PATH, connectionId)
      const { runtime, spawn, reveal } = hostLane(scope)

      // worker-topology.ts createExistingWorktreeWorkerTerminal's options.
      const created = await runtime.createTerminal(`id:${scope.id}`, {
        startupAgent: 'claude',
        launchSource: 'orchestration',
        title: 'worker-task-1',
        surfaceOwner: false
      })

      const args = spawnArgs(spawn)
      expect(pickSpawnFacts(args)).toStrictEqual({
        command: POSIX,
        cols: 120,
        rows: 40,
        initiallyHidden: true,
        persistHostSessionBinding: true,
        placement: { kind: 'new-tab' },
        commandDelivery: 'provider',
        startupCommandDelivery: undefined,
        cwd: POSIX_PATH,
        connectionId,
        launchAgent: 'claude',
        telemetry: {
          agent_kind: 'claude-code',
          launch_source: 'orchestration',
          request_kind: 'new'
        }
      })
      expect(args).not.toHaveProperty('shellOverride')
      expect(orcaEnvKeys(spawn)).toEqual(expectedOrcaEnvKeys(kind))
      // No reserved pane: the host mints its own tab and leaf.
      expect(created.tabId).toBe(args.tabId)
      expect(created.paneKey).toBe(`${String(args.tabId)}:${String(args.leafId)}`)
      expect(created.title).toBe('worker-task-1')
      expect(reveal.mock.calls[0]?.[1]).toMatchObject({
        title: 'worker-task-1',
        activate: false,
        surfaceOwner: false
      })
      expect(reveal.mock.calls[0]?.[1]).not.toHaveProperty('presentation')
      const tab = internalsOf(runtime).mobileSessionTabsByWorktree.get(scope.id)?.tabs[0]
      expect(tab).toMatchObject({ title: 'worker-task-1', isActive: true })
      expect(tab).not.toHaveProperty('viewMode')
    }
  )
})
