/**
 * What the host lane hands `ptyController.spawn` when the caller already built the launch
 * (rows 5r legacy, 8 paired and local-git), and when `createAgentSession` builds an OpenCode
 * model launch for a window pane (row 4, host half).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyManagedDataAccountEnvironment } from '../managed-data-accounts/launch-environment'
import { probeOpenCodeLaunchCapabilities } from '../opencode/opencode-launch-capabilities'
import {
  probeOpenCodeModelAvailability,
  resolveOpenCodeDirectModelExecutable
} from '../opencode/opencode-model-availability'
import { probeOpenCodeLaunchModelContext } from '../opencode/opencode-launch-model-context'
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
  WSL_PATH
} from './orca-runtime-host-lane-spawn-test-fixture'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))
vi.mock('../managed-data-accounts/launch-environment', () => ({
  applyManagedDataAccountEnvironment: vi.fn()
}))
vi.mock('../opencode/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: vi.fn()
}))
vi.mock('../opencode/opencode-model-availability', () => ({
  resolveOpenCodeDirectModelExecutable: vi.fn(),
  probeOpenCodeModelAvailability: vi.fn()
}))
vi.mock('../opencode/opencode-launch-model-context', () => ({
  probeOpenCodeLaunchModelContext: vi.fn()
}))

const ORIGINAL_PLATFORM = process.platform
const MODEL = 'opencode/fledge-alpha-free'

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM)
  vi.restoreAllMocks()
})

// A window-built launch quoted for a Windows cmd.exe client; the host must not re-quote it.
const CLIENT_COMMAND = 'claude "--dangerously-skip-permissions" "run remotely"'
const LAUNCH_CONFIG = {
  agentCommand: 'claude',
  agentArgs: '--dangerously-skip-permissions',
  agentEnv: {}
}
// Stale pane identity in the client env, which the host overwrites with its own.
const CLIENT_ENV = {
  CUSTOM_FLAG: '1',
  ORCA_PANE_KEY: 'stale-tab:stale-leaf',
  ORCA_TAB_ID: 'stale-tab',
  ORCA_WORKTREE_ID: 'stale-worktree',
  ORCA_AGENT_LAUNCH_TOKEN: 'client-token'
}

type CallerLaunchRow = {
  producer: string
  options: TerminalCreateOptions
  startupCommandDelivery: 'shell-ready' | undefined
  telemetry: unknown
  launchToken: string | null
  tabId: string | null
  title: string | null
}

const CALLER_LAUNCH_ROWS: CallerLaunchRow[] = [
  {
    // terminal-lifecycle-methods.ts terminal.create from runtime-agent-background-create.ts (legacy).
    producer: '5r legacy terminal.create',
    options: {
      command: CLIENT_COMMAND,
      startupCommandDelivery: undefined,
      env: CLIENT_ENV,
      envToDelete: undefined,
      launchConfig: LAUNCH_CONFIG,
      launchToken: 'launch-token-1',
      launchAgent: 'claude',
      title: 'Nightly triage',
      focus: false,
      rendererBacked: false,
      activate: false,
      presentation: 'background',
      tabId: TAB_ID,
      leafId: LEAF_ID
    },
    startupCommandDelivery: undefined,
    telemetry: undefined,
    launchToken: 'launch-token-1',
    tabId: TAB_ID,
    title: 'Nightly triage'
  },
  {
    // runtime-local-worktree-terminal-startup.ts for a paired worktree.create (telemetry dropped).
    producer: '8 paired worktree.create',
    options: {
      command: CLIENT_COMMAND,
      env: CLIENT_ENV,
      launchConfig: LAUNCH_CONFIG,
      launchAgent: 'claude',
      startupCommandDelivery: 'shell-ready',
      telemetry: undefined,
      surfaceOwner: false
    },
    startupCommandDelivery: 'shell-ready',
    telemetry: undefined,
    launchToken: null,
    tabId: null,
    title: null
  },
  {
    // worktree-remote.ts spawnLocalStartupAndSetupTerminals: the local IPC create keeps telemetry.
    producer: '8 local-git worktrees:create',
    options: {
      command: CLIENT_COMMAND,
      env: CLIENT_ENV,
      launchConfig: LAUNCH_CONFIG,
      launchAgent: 'claude',
      startupCommandDelivery: undefined,
      telemetry: {
        agent_kind: 'claude-code',
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      },
      surfaceOwner: false
    },
    startupCommandDelivery: undefined,
    telemetry: {
      agent_kind: 'claude-code',
      launch_source: 'new_workspace_composer',
      request_kind: 'new'
    },
    launchToken: null,
    tabId: null,
    title: null
  }
]

// Pins main's current launch behaviour as the convergence parity baseline (rows 5r legacy, 8 paired, 8 local-git; host lane): a caller-built launch reaches spawn verbatim.
describe('caller-supplied launch -> ptyController.spawn', () => {
  it.each(CALLER_LAUNCH_ROWS)(
    '$producer runs the command verbatim on a linux host',
    async ({ options, startupCommandDelivery, telemetry, launchToken, tabId, title }) => {
      setPlatform('linux')
      const scope = workspaceScope('repo', POSIX_PATH, null)
      // The agent is disabled on the host, yet nothing on this path checks it.
      const { runtime, spawn } = hostLane(scope, { disabledTuiAgents: ['claude'] })

      const created = await runtime.createTerminal(`id:${scope.id}`, options)

      const args = spawnArgs(spawn)
      // main today: no re-plan for a repo scope; cmd.exe quoting runs on a linux host as sent.
      expect(pickSpawnFacts(args)).toStrictEqual({
        command: CLIENT_COMMAND,
        cols: 120,
        rows: 40,
        initiallyHidden: true,
        persistHostSessionBinding: true,
        placement: { kind: 'new-tab' },
        commandDelivery: 'provider',
        startupCommandDelivery,
        cwd: POSIX_PATH,
        connectionId: null,
        launchAgent: 'claude',
        telemetry
      })
      expect(args).not.toHaveProperty('shellOverride')
      if (tabId) {
        expect(args.tabId).toBe(tabId)
        expect(args.leafId).toBe(LEAF_ID)
      }
      const env = spawnEnv(spawn)
      expect(orcaEnvKeys(spawn)).toEqual(expectedOrcaEnvKeys('repo'))
      expect(env.CUSTOM_FLAG).toBe('1')
      expect(env.ORCA_PANE_KEY).toBe(`${String(args.tabId)}:${String(args.leafId)}`)
      expect(env.ORCA_TAB_ID).toBe(args.tabId)
      expect(env.ORCA_WORKTREE_ID).toBe(scope.id)
      if (launchToken) {
        expect(env.ORCA_AGENT_LAUNCH_TOKEN).toBe(launchToken)
      } else {
        // No launchToken: the host mints one and it replaces the client env's value.
        expect(env.ORCA_AGENT_LAUNCH_TOKEN).toMatch(/^[0-9a-f-]{36}$/)
      }
      expect(created.title).toBe(title)
      expect(created.surface).toBe(options.presentation === 'background' ? 'background' : 'visible')
    }
  )

  it('keeps the caller title on the PTY record and the phone tab of a background create', async () => {
    setPlatform('linux')
    const scope = workspaceScope('folder', POSIX_PATH, 'ssh-1')
    const { runtime, spawn, reveal } = hostLane(scope)

    const created = await runtime.createTerminal(`id:${scope.id}`, CALLER_LAUNCH_ROWS[0].options)

    expect(created).toMatchObject({
      paneKey: PANE_KEY,
      title: 'Nightly triage',
      surface: 'background'
    })
    expect(reveal).not.toHaveBeenCalled()
    expect(spawnArgs(spawn).connectionId).toBe('ssh-1')
    expect(orcaEnvKeys(spawn)).toEqual(expectedOrcaEnvKeys('folder'))
    expect('JCODE_RUNTIME_DIR' in spawnEnv(spawn)).toBe(false)
    const snapshot = internalsOf(runtime).mobileSessionTabsByWorktree.get(scope.id)
    expect(snapshot?.tabs[0]).toMatchObject({
      title: 'Nightly triage',
      launchAgent: 'claude',
      isActive: false
    })
    expect(snapshot?.activeTabId).toBeNull()
  })
})

function operationId(): string {
  return `${Date.now()}-0123456789abcdef0123456789abcdef`
}

function stubOpenCodeV2Probes(): void {
  vi.mocked(applyManagedDataAccountEnvironment).mockReset()
  vi.mocked(resolveOpenCodeDirectModelExecutable).mockReset().mockResolvedValue('/bin/opencode')
  vi.mocked(probeOpenCodeLaunchCapabilities).mockReset().mockResolvedValue({
    version: '2.0.16',
    pluginApi: 'v2',
    promptMode: 'prefill'
  })
  vi.mocked(probeOpenCodeModelAvailability).mockReset().mockResolvedValue(true)
  vi.mocked(probeOpenCodeLaunchModelContext)
    .mockReset()
    .mockResolvedValueOnce({
      primaryAgent: 'build',
      availableModels: [MODEL],
      primaryModel: 'opencode/big-pickle'
    })
    .mockResolvedValue({ primaryAgent: 'build', availableModels: [MODEL], primaryModel: MODEL })
}

// spawnIpcPty's terminal.createAgentSession params for an OpenCode pane with a model pick.
function openCodePaneRequest(worktreeId: string) {
  return {
    clientOperationId: operationId(),
    worktree: `id:${worktreeId}`,
    agent: 'opencode' as const,
    launchPreferences: { model: MODEL },
    placement: { tabId: TAB_ID, leafId: LEAF_ID },
    presentation: 'background' as const
  }
}

const DESKTOP_CALLER = { clientId: 'desktop-renderer', clientKind: 'runtime' as const }

// Pins main's current launch behaviour as the convergence parity baseline (row 4, host half): createAgentSession's OpenCode model launch at the spawn boundary.
describe('createAgentSession OpenCode model launch -> ptyController.spawn', () => {
  beforeEach(() => {
    stubOpenCodeV2Probes()
  })

  it.each(['repo', 'folder'] as const)(
    'spawns the host-built v2 launch in the renderer pane (%s)',
    async (kind) => {
      setPlatform('darwin')
      const scope = workspaceScope(kind, POSIX_PATH, null)
      const { runtime, spawn, reveal } = hostLane(scope)

      const result = await runtime.createAgentSession(openCodePaneRequest(scope.id), DESKTOP_CALLER)

      const args = spawnArgs(spawn)
      expect(pickSpawnFacts(args)).toStrictEqual({
        command: "opencode '--standalone'",
        cols: 120,
        rows: 40,
        initiallyHidden: true,
        persistHostSessionBinding: true,
        placement: { kind: 'new-tab' },
        commandDelivery: 'provider',
        startupCommandDelivery: undefined,
        cwd: POSIX_PATH,
        connectionId: null,
        launchAgent: 'opencode',
        // main today: the pane's own launch_source never reaches the host.
        telemetry: { agent_kind: 'opencode', launch_source: 'unknown', request_kind: 'new' }
      })
      expect(args).not.toHaveProperty('shellOverride')
      expect(args.tabId).toBe(TAB_ID)
      expect(args.leafId).toBe(LEAF_ID)
      expect(args.preAllocatedHandle).toMatch(/^term_[0-9a-f-]{36}$/)
      // main today: a repo worktree gets no ORCA_WORKSPACE_ID on this lane.
      expect(orcaEnvKeys(spawn)).toEqual(expectedOrcaEnvKeys(kind))
      expect(spawnEnv(spawn).ORCA_PANE_KEY).toBe(PANE_KEY)
      expect(JSON.parse(spawnEnv(spawn).OPENCODE_CONFIG_CONTENT ?? 'null')).toEqual({
        model: MODEL,
        agents: { build: { model: MODEL } }
      })
      expect(result).toMatchObject({
        disposition: 'created',
        terminal: { paneKey: PANE_KEY, surface: 'background' }
      })
      expect(reveal).not.toHaveBeenCalled()
    }
  )

  it.each([
    { os: 'win32' as const, kind: 'folder' as const, path: WSL_PATH, connectionId: null },
    { os: 'darwin' as const, kind: 'repo' as const, path: POSIX_PATH, connectionId: 'ssh-1' }
  ])(
    'refuses $kind at $path (connection=$connectionId) before any probe or spawn',
    async ({ os, kind, path, connectionId }) => {
      setPlatform(os)
      const scope = workspaceScope(kind, path, connectionId)
      const { runtime, spawn } = hostLane(scope)

      await expect(
        runtime.createAgentSession(openCodePaneRequest(scope.id), DESKTOP_CALLER)
      ).rejects.toMatchObject({
        code: 'capability_unsupported',
        message: 'The execution host cannot verify this OpenCode model launch.'
      })
      expect(resolveOpenCodeDirectModelExecutable).not.toHaveBeenCalled()
      expect(spawn).not.toHaveBeenCalled()
    }
  )

  it('does not refuse a Windows \\\\wsl$ repo with no WSL project runtime', async () => {
    setPlatform('win32')
    const scope = workspaceScope('repo', WSL_PATH, null)
    const { runtime, spawn } = hostLane(scope)

    await runtime.createAgentSession(openCodePaneRequest(scope.id), DESKTOP_CALLER)

    // main today: the repo branch quotes for win32, which matches the host, so the probe runs natively.
    expect(spawnArgs(spawn).command).toBe('opencode "--standalone"')
    expect(spawnArgs(spawn).cwd).toBe(WSL_PATH)
  })

  it('spawns a native Windows C:\\ repo with cmd.exe quoting', async () => {
    setPlatform('win32')
    const scope = workspaceScope('repo', WIN_PATH, null)
    const { runtime, spawn } = hostLane(scope)

    await runtime.createAgentSession(openCodePaneRequest(scope.id), DESKTOP_CALLER)

    expect(spawnArgs(spawn).command).toBe('opencode "--standalone"')
    expect(orcaEnvKeys(spawn)).toEqual(expectedOrcaEnvKeys('repo'))
    expect('JCODE_RUNTIME_DIR' in spawnEnv(spawn)).toBe(false)
  })

  it('refuses a disabled agent with the exact create message and spawns nothing', async () => {
    setPlatform('darwin')
    const scope = workspaceScope('repo', POSIX_PATH, null)
    const { runtime, spawn } = hostLane(scope, { disabledTuiAgents: ['opencode'] })

    await expect(
      runtime.createAgentSession(openCodePaneRequest(scope.id), DESKTOP_CALLER)
    ).rejects.toThrow(
      new Error('Selected agent is disabled. Choose an enabled agent before creating.')
    )
    expect(resolveOpenCodeDirectModelExecutable).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })
})
