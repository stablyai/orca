import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { classifyErrorMock, statSyncMock, trackMock } from './pty-ipc-mock-registry'
import {
  providerFacts,
  recordOf,
  restoreMainPlatform,
  setMainPlatform,
  startParityLanes,
  type ParityLanes
} from './pty-launch-parity-fixture'
import {
  POSIX_PATH,
  WINDOW_LAUNCH_CASES,
  WSL_PATH
} from '../../shared/launch-parity-window-cases.test-fixture'
import {
  expectedWindowProvider,
  launchWorkspaceId,
  windowSpawnRequest,
  type LaunchWorkspace,
  type WindowProviderFacts
} from '../../shared/launch-parity-window-request.test-fixture'
import {
  AUTOMATION_LAUNCH_CASES,
  automationSpawnRequest
} from '../../shared/launch-parity-automation-cases.test-fixture'
import {
  expectedHostProvider,
  HOST_LAUNCH_CASES,
  type HostLaunchCase
} from './pty-launch-parity-host-cases'
import { CALLER_LAUNCH_CASES, OPENCODE_MODEL } from './pty-launch-parity-caller-cases'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { DESKTOP_RPC_CALLER } from '../runtime/rpc/rpc-caller-identity'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from './desktop-renderer-runtime-capabilities'
import { TERMINAL_LIFECYCLE_METHODS } from '../runtime/rpc/methods/terminal/terminal-lifecycle-methods'
import { AGENT_SESSION_METHODS } from '../runtime/rpc/methods/agent-session'
import { applyManagedDataAccountEnvironment } from '../managed-data-accounts/launch-environment'
import { probeOpenCodeLaunchCapabilities } from '../opencode/opencode-launch-capabilities'
import {
  probeOpenCodeModelAvailability,
  resolveOpenCodeDirectModelExecutable
} from '../opencode/opencode-model-availability'
import { probeOpenCodeLaunchModelContext } from '../opencode/opencode-launch-model-context'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
// Why: an OpenCode v2 install with the picked model available; the probes would run the binary.
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
// Why: every folder in the table exists on its host; main checks that before it spawns.
vi.mock('../project-groups/folder-workspace-path-status', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFolderWorkspacePathStatus: vi.fn(async () => ({ path: '', exists: true }))
}))
// Why: no Antigravity account is selected on this machine, so the account switch before an agy launch is a no-op.
vi.mock('../antigravity/native-account-launch', () => ({
  prepareAntigravityAccountForLaunch: vi.fn(async () => {})
}))
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

type WindowLaneCase = {
  label: string
  client: NodeJS.Platform
  workspace: LaunchWorkspace
  settings?: Record<string, unknown>
  request: Record<string, unknown>
  provider: WindowProviderFacts
  /** The agent env the case saved, as the provider must receive it. */
  env: Record<string, string>
}

const WINDOW_LANE_CASES: WindowLaneCase[] = [
  ...WINDOW_LAUNCH_CASES.map((c) => ({
    ...c,
    label: `row ${c.row}: ${c.name}`,
    request: windowSpawnRequest(c),
    env: c.request.agentEnv ?? {}
  })),
  ...AUTOMATION_LAUNCH_CASES.map((c) => ({
    ...c,
    label: `row 5: ${c.name}`,
    request: automationSpawnRequest(c),
    env: {}
  }))
]

// Pins main's current launch behaviour as the convergence parity baseline (rows 2, 5 and 6, main
// half; rules WINDOW_PANE, IPC_SSH_DEFAULT_SHELL, AUTOMATION_WSL_EXE): each table request, fed to
// pty:spawn, reaches the provider with these facts (the pane's measured size, never hidden), one
// agent_started, and a binding without host-admitted membership.
describe('window lane: pty:spawn request -> provider', () => {
  const suite = setupPtyIpcSuite()
  afterEach(() => restoreMainPlatform())

  it.each(WINDOW_LANE_CASES)(
    '$label',
    async ({ client, workspace, settings, request, provider, env: agentEnv }) => {
      // A desktop client's main process runs on the client OS, SSH included.
      setMainPlatform(client)
      const lanes = startParityLanes(suite, { workspace, settings })
      await lanes.spawnWindow(request)

      expect(await providerFacts(lanes.provider)).toEqual(
        expectedWindowProvider(request, provider, agentEnv)
      )
      expect(trackMock.mock.calls).toEqual([['agent_started', request.telemetry]])
      expect(lanes.persistPtyBinding.mock.calls).toEqual([
        [
          {
            worktreeId: request.worktreeId,
            tabId: request.tabId,
            leafId: request.leafId,
            ptyId: expect.any(String),
            startupCwd: expect.any(String),
            ...pick(request, ['placement']),
            origin: 'spawn'
          },
          ...(workspace.connectionId ? [`ssh:${workspace.connectionId}`] : [])
        ]
      ])
    }
  )
})

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]))
}

function stubOpenCodeV2(): void {
  vi.mocked(applyManagedDataAccountEnvironment).mockReset()
  vi.mocked(resolveOpenCodeDirectModelExecutable).mockReset().mockResolvedValue('/bin/opencode')
  vi.mocked(probeOpenCodeLaunchCapabilities)
    .mockReset()
    .mockResolvedValue({ version: '2.0.16', pluginApi: 'v2', promptMode: 'prefill' })
  vi.mocked(probeOpenCodeModelAvailability).mockReset().mockResolvedValue(true)
  vi.mocked(probeOpenCodeLaunchModelContext)
    .mockReset()
    .mockResolvedValueOnce({
      primaryAgent: 'build',
      availableModels: [OPENCODE_MODEL],
      primaryModel: 'opencode/big-pickle'
    })
    .mockResolvedValue({
      primaryAgent: 'build',
      availableModels: [OPENCODE_MODEL],
      primaryModel: OPENCODE_MODEL
    })
}

async function runHostCall(lanes: ParityLanes, c: HostLaunchCase): Promise<unknown> {
  if (c.call.kind === 'create') {
    return lanes.runtime.createTerminal(`id:${launchWorkspaceId(c.workspace)}`, c.call.options)
  }
  const { method, params } = c.call
  const dispatcher = new RpcDispatcher({
    runtime: lanes.runtime,
    methods: [...TERMINAL_LIFECYCLE_METHODS, ...AGENT_SESSION_METHODS]
  })
  const response = await dispatcher.dispatch(
    {
      id: 'parity',
      // The transport authenticated the caller before dispatch; the dispatcher only carries it.
      authToken: 'token',
      method,
      params:
        method === 'terminal.createAgentSession'
          ? { clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`, ...params }
          : params
    },
    // Row 4 is the desktop's own runtime:call (ipc/runtime.ts); rows 5r and 7 come from a paired desktop.
    c.row === '4'
      ? {
          clientId: 'desktop-renderer',
          caller: DESKTOP_RPC_CALLER,
          clientKind: 'runtime',
          connectionId: 'desktop-window-1',
          clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
        }
      : { clientId: 'device-1', pairedDeviceId: 'device-1', clientKind: 'runtime' }
  )
  if (!response.ok) {
    throw Object.assign(new Error(response.error.message), { code: response.error.code })
  }
  return response.result
}

// Pins main's current launch behaviour as the convergence parity baseline (rows 3, 4, 5r, 7, 8, 10;
// rules HOST_REPO, HOST_FOLDER_PATH, RUNTIME_ASSEMBLER): each host producer's call reaches the
// provider through the real runtime controller with these facts, telemetry, membership and phone tab.
describe('host lane: producer call -> runtime controller -> provider', () => {
  const suite = setupPtyIpcSuite()
  beforeEach(() => stubOpenCodeV2())
  afterEach(() => restoreMainPlatform())

  it.each([...HOST_LAUNCH_CASES, ...CALLER_LAUNCH_CASES])('row $row: $name', async (c) => {
    setMainPlatform(c.os)
    const lanes = startParityLanes(suite, { workspace: c.workspace, settings: c.settings })
    await runHostCall(lanes, c)

    expect(await providerFacts(lanes.provider)).toEqual(expectedHostProvider(c))
    // The host stamps its own pane identity (the window lane's stale-key case is below).
    const spawned = recordOf(lanes.provider.mock.calls.at(-1)?.[0])
    expect(recordOf(spawned.env).ORCA_PANE_KEY).toBe(spawned.paneKey)
    expect(trackMock.mock.calls).toEqual(c.telemetry ? [['agent_started', c.telemetry]] : [])
    expect(lanes.persistPtyBinding.mock.calls[0]?.[0]).toMatchObject({
      hostAdmittedMembership: true,
      placement: { kind: 'new-tab' }
    })
    const phone = await lanes.runtime.listMobileSessionTabs(`id:${launchWorkspaceId(c.workspace)}`)
    expect(pick({ ...phone.tabs[0] }, ['title', 'launchAgent', 'isActive'])).toEqual(c.phone)
  })
})

const POSIX_REPO = { kind: 'repo', path: POSIX_PATH } as const
const SSH_REPO = { ...POSIX_REPO, connectionId: 'ssh-1' } as const
const [AI_BUTTON] = HOST_LAUNCH_CASES
const AI_BUTTON_OPTIONS = AI_BUTTON.call.kind === 'create' ? AI_BUTTON.call.options : {}
const OPENCODE = CALLER_LAUNCH_CASES.find((c) => c.row === '4')!
const CALLER_5R = CALLER_LAUNCH_CASES.find((c) => c.row === '5r')!
const WORKER = HOST_LAUNCH_CASES.find((c) => c.name.startsWith('orchestration worker'))!

// Pins main's current launch behaviour as the convergence parity baseline (rows 3, 4, 5r and 10;
// disabled agent, failed spawn, missing cwd, reveal): the facts no single table row carries.
describe('launch facts outside the tables', () => {
  const suite = setupPtyIpcSuite()
  beforeEach(() => stubOpenCodeV2())
  afterEach(() => restoreMainPlatform())

  it.each([
    {
      c: AI_BUTTON,
      agent: 'claude',
      message: 'Agent claude is disabled. Choose an enabled agent.'
    },
    {
      c: OPENCODE,
      agent: 'opencode',
      message: 'Selected agent is disabled. Choose an enabled agent before creating.'
    }
  ])('row $c.row: the host refuses a disabled $agent and spawns nothing', async (row) => {
    setMainPlatform('darwin')
    const lanes = startParityLanes(suite, {
      workspace: row.c.workspace,
      settings: { disabledTuiAgents: [row.agent] }
    })
    await expect(runHostCall(lanes, row.c)).rejects.toThrow(row.message)
    expect(lanes.provider).not.toHaveBeenCalled()
  })

  it('row 5r: a caller-built launch of a disabled agent still spawns', async () => {
    setMainPlatform('linux')
    const lanes = startParityLanes(suite, {
      workspace: CALLER_5R.workspace,
      settings: { disabledTuiAgents: ['claude'] }
    })
    await runHostCall(lanes, CALLER_5R)
    expect(lanes.provider).toHaveBeenCalledOnce()
  })

  it.each([
    { os: 'win32', workspace: { kind: 'folder', path: WSL_PATH } },
    { os: 'darwin', workspace: SSH_REPO }
  ] as const)('row 4: refuses OpenCode at $workspace.path ($os) before any spawn', async (c) => {
    setMainPlatform(c.os)
    const lanes = startParityLanes(suite, { workspace: c.workspace })
    await expect(runHostCall(lanes, { ...OPENCODE, workspace: c.workspace })).rejects.toMatchObject(
      {
        code: 'capability_unsupported',
        message: 'The execution host cannot verify this OpenCode model launch.'
      }
    )
    expect(lanes.provider).not.toHaveBeenCalled()
  })

  // main today: only the window lane reports agent_error; a host-lane failure reports nothing.
  it.each([
    { lane: 'host', workspace: POSIX_REPO, request: null, calls: [] },
    {
      lane: 'window, telemetry kind wins over the claude sniff',
      workspace: POSIX_REPO,
      request: { command: 'claude', telemetry: { agent_kind: 'opencode' } },
      calls: [['agent_error', { agent_kind: 'opencode', error_class: 'binary_not_found' }]]
    },
    {
      lane: 'window, local claude without telemetry',
      workspace: POSIX_REPO,
      request: { command: 'claude' },
      calls: [['agent_error', { agent_kind: 'claude-code', error_class: 'binary_not_found' }]]
    },
    { lane: 'window, non-claude', workspace: POSIX_REPO, request: { command: 'aider' }, calls: [] },
    // The claude sniff is local-only.
    { lane: 'window, SSH claude', workspace: SSH_REPO, request: { command: 'claude' }, calls: [] }
  ] as const)('a failed $lane spawn emits $calls.length agent_error', async (c) => {
    setMainPlatform('darwin')
    classifyErrorMock.mockReturnValue({ error_class: 'binary_not_found' })
    const spawnError = new Error('spawn boom')
    const lanes = startParityLanes(suite, { workspace: c.workspace, spawnError })
    const launch = c.request
      ? lanes.spawnWindow({
          cols: 80,
          rows: 24,
          cwd: c.workspace.path,
          worktreeId: launchWorkspaceId(c.workspace),
          ...(c.workspace.kind === 'repo' && 'connectionId' in c.workspace
            ? { connectionId: c.workspace.connectionId }
            : {}),
          ...c.request
        })
      : runHostCall(lanes, AI_BUTTON)
    await expect(launch).rejects.toThrow('spawn boom')
    expect(trackMock.mock.calls.filter(([event]) => event === 'agent_error')).toEqual(c.calls)
  })

  // main today: neither refuses a gone folder before the spawn; the window pane's root fallback is
  // pinned in pty-spawn-cwd-fallback.test.ts (an automation sends no cwdFallback, at the request).
  it.each([
    { lane: 'row 3: a gone host-lane subfolder', cwd: `${POSIX_PATH}/gone` },
    { lane: 'row 5: a gone automation root', cwd: POSIX_PATH }
  ])('$lane reaches the provider unchanged', async ({ lane, cwd }) => {
    setMainPlatform('darwin')
    statSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
    await (lane.startsWith('row 3')
      ? runHostCall(lanes, {
          ...AI_BUTTON,
          call: { kind: 'create', options: { ...AI_BUTTON_OPTIONS, cwd: 'gone' } }
        })
      : lanes.spawnWindow(automationSpawnRequest(AUTOMATION_LAUNCH_CASES[0])))
    expect((await providerFacts(lanes.provider)).cwd).toBe(cwd)
  })

  it.each([
    { c: AI_BUTTON, reveal: { title: null, activate: false, surfaceOwner: false } },
    { c: WORKER, reveal: { title: 'worker-task-1', activate: false, surfaceOwner: false } },
    // A background create (legacy automation, OpenCode pane) never asks the window to reveal.
    { c: CALLER_5R, reveal: null },
    { c: OPENCODE, reveal: null }
  ])('row $c.row: reveal request $reveal', async ({ c, reveal }) => {
    setMainPlatform(c.os)
    const lanes = startParityLanes(suite, { workspace: c.workspace, settings: c.settings })
    await runHostCall(lanes, c)
    if (!reveal) {
      expect(lanes.reveal).not.toHaveBeenCalled()
      return
    }
    expect(lanes.reveal.mock.calls[0]?.[1]).toMatchObject(reveal)
    expect(lanes.reveal.mock.calls[0]?.[1]).not.toHaveProperty('presentation')
  })

  // main rewrites stale pane identity keys from the request's tab and leaf; workspace keys pass.
  it('window lane: the provider gets the pane keys main derives, not the stale ones sent', async () => {
    setMainPlatform('darwin')
    const tabId = '55555555-5555-4555-8555-555555555555'
    const leafId = '66666666-6666-4666-8666-666666666666'
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
    await lanes.spawnWindow({
      cols: 80,
      rows: 24,
      cwd: POSIX_PATH,
      worktreeId: launchWorkspaceId(POSIX_REPO),
      tabId,
      leafId,
      env: { ORCA_WORKSPACE_ID: 'folder:f1', ORCA_PANE_KEY: 'stale', ORCA_TAB_ID: 'stale' }
    })
    const env = recordOf(recordOf(lanes.provider.mock.calls.at(-1)?.[0]).env)
    expect(pick(env, ['ORCA_WORKSPACE_ID', 'ORCA_PANE_KEY', 'ORCA_TAB_ID'])).toEqual({
      ORCA_WORKSPACE_ID: 'folder:f1',
      ORCA_PANE_KEY: `${tabId}:${leafId}`,
      ORCA_TAB_ID: tabId
    })
  })

  // main today: an unmeasured hidden pane's 0x0 grid is not clamped before the provider.
  it('window lane: a hidden unmeasured pane reaches the provider at 0x0, marked hidden', async () => {
    setMainPlatform('darwin')
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
    await lanes.spawnWindow({
      cols: 0,
      rows: 0,
      initiallyHidden: true,
      cwd: POSIX_PATH,
      worktreeId: launchWorkspaceId(POSIX_REPO)
    })
    expect(await providerFacts(lanes.provider)).toMatchObject({ cols: 0, rows: 0, hidden: true })
  })
})
