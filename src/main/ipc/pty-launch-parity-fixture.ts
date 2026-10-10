// Test-only: one real OrcaRuntimeService wired into the real pty handlers, so both launch lanes
// reach the same fake provider. Window lane: pty:spawn. Host lane: createTerminal / createAgentSession
// through the runtime controller registerPtyHandlers installs. Suites still declare the IPC vi.mock block.
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { registerPtyHandlers, registerSshPtyProvider } from './pty'
import { existsSyncMock, statSyncMock } from './pty-ipc-mock-registry'
import type { PtyIpcSuiteFixtures } from './pty-ipc-test-harness'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { TerminalWorkspaceLaunchScope } from '../runtime/runtime-legacy-worker-terminal-recovery-types'
import {
  IDENTITY_ENV_KEYS,
  type LaunchWorkspace
} from '../../shared/launch-parity-window-request.test-fixture'
import { isHiddenRendererPty } from './pty-hidden-delivery-gate'
import { HOST_TAB_ID } from './pty-launch-parity-host-cases'

const WINDOWS_ENV = {
  COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
  USERPROFILE: 'C:\\Users\\test',
  SystemRoot: 'C:\\Windows',
  ProgramW6432: 'C:\\Program Files',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': undefined
}
const ORIGINAL_PLATFORM = process.platform
const savedEnv = new Map<string, string | undefined>()
let remoteSpawns = 0

/** Main's process.platform for a case; Windows also gets the env and .exe probes its shells read. */
export function setMainPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  if (platform !== 'win32') {
    return
  }
  for (const [key, value] of Object.entries(WINDOWS_ENV)) {
    if (!savedEnv.has(key)) {
      savedEnv.set(key, process.env[key])
    }
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  statSyncMock.mockImplementation((target: string) => {
    const isExe = /\.exe$/i.test(String(target))
    return { isDirectory: () => !isExe, isFile: () => isExe, size: 1024, mode: 0o755 }
  })
  existsSyncMock.mockReturnValue(true)
}

export function restoreMainPlatform(): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: ORIGINAL_PLATFORM })
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  savedEnv.clear()
}

/** Settings both lanes read on main's current OS; the untrimmed default shell shows which reads trim it. */
function parityMainSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // Windows hides the default-shell setting and defaults it to ''.
    terminalDefaultShell: process.platform === 'win32' ? '' : '  /bin/zsh  ',
    terminalDefaultShellArgs: ['-l'],
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsPowerShellImplementation: 'auto',
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    // Why off: a fresh agent launch would otherwise write workspace trust into the agent's home.
    agentWorkspaceTrustEnabled: false,
    ...overrides
  }
}

function launchScope(workspace: LaunchWorkspace): TerminalWorkspaceLaunchScope {
  const connectionId = workspace.connectionId ?? null
  if (workspace.kind === 'repo') {
    return {
      id: `repo-1::${workspace.path}`,
      path: workspace.path,
      connectionId,
      repo: {
        id: 'repo-1',
        path: workspace.path,
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0,
        connectionId
      },
      folderWorkspace: null
    }
  }
  return {
    id: 'folder:fw-1',
    path: workspace.path,
    connectionId,
    repo: null,
    folderWorkspace: {
      id: 'fw-1',
      projectGroupId: 'pg-1',
      name: 'folder',
      folderPath: workspace.path,
      connectionId,
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
  }
}

type ScopeResolver = {
  resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<TerminalWorkspaceLaunchScope>
}

export type ParityLanes = {
  runtime: OrcaRuntimeService
  /** The provider spawn mock for the lane's host (daemon locally, relay over SSH). */
  provider: Mock
  persistPtyBinding: Mock
  reveal: Mock
  spawnWindow: (request: Record<string, unknown>) => Promise<unknown>
}

/** Wires one runtime + handlers for a workspace (its saved project runtime included). */
export function startParityLanes(
  suite: Pick<PtyIpcSuiteFixtures, 'handlers' | 'mainWindow' | 'installDaemonTestProvider'>,
  args: {
    workspace: LaunchWorkspace
    settings?: Record<string, unknown>
    spawnError?: Error
  }
): ParityLanes {
  const settings = parityMainSettings(args.settings)
  const persistPtyBinding = vi.fn(async () => true)
  const { repo, folderWorkspace } = launchScope(args.workspace)
  const store = {
    getSettings: () => settings,
    getProjects: () => [
      {
        id: 'project-1',
        sourceRepoIds: ['repo-1'],
        ...(args.workspace.projectRuntime
          ? { localWindowsRuntimePreference: args.workspace.projectRuntime }
          : {})
      }
    ],
    getRepo: (id: string) => (repo && id === repo.id ? repo : undefined),
    getRepos: () => (repo ? [repo] : []),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getWorkspaceSession: () => ({ tabsByWorktree: {}, terminalLayoutsByTabId: {} }),
    getFolderWorkspace: () => folderWorkspace ?? undefined,
    getFolderWorkspaces: () => (folderWorkspace ? [folderWorkspace] : []),
    getProjectGroups: () => [{ id: 'pg-1', name: 'group', parentPath: null, connectionId: null }],
    persistPtyBinding,
    upsertSshRemotePtyLease: vi.fn(),
    supersedeSshRemotePtyLeasesForBoundPane: vi.fn(),
    markSshRemotePtyLease: vi.fn(),
    removeSshRemotePtyLease: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launches read only the store members defined above; the rest of the persistence store is unreachable here.
  const runtime = new OrcaRuntimeService(store as never)
  const provider = vi.fn(async (options: { sessionId?: string }) => {
    if (args.spawnError) {
      throw args.spawnError
    }
    // A fresh id per spawn, so one case's hidden mark never reads into the next.
    return { id: options.sessionId ?? `remote-pty-${++remoteSpawns}` }
  })
  if (args.workspace.connectionId) {
    installSshTestProvider(args.workspace.connectionId, provider)
  } else {
    suite.installDaemonTestProvider({ spawn: provider })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read the window, runtime, settings and store members these fakes define.
  const handlerArgs = [
    suite.mainWindow,
    runtime,
    undefined,
    () => settings,
    undefined,
    store
  ] as unknown as Parameters<typeof registerPtyHandlers>
  registerPtyHandlers(...handlerArgs)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver is a real (protected) runtime method; the scope is this case's input, not an assertion.
  const resolver = runtime as unknown as ScopeResolver
  vi.spyOn(resolver, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue(
    launchScope(args.workspace)
  )
  const reveal = vi.fn().mockResolvedValue({ tabId: HOST_TAB_ID })
  runtime.setNotifier({
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    revealTerminalSession: reveal,
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  return {
    runtime,
    provider,
    persistPtyBinding,
    reveal,
    spawnWindow: async (request) => suite.handlers.get('pty:spawn')!(null, request)
  }
}

/** Registers an SSH relay double whose spawn mock sees the full PtySpawnOptions. */
function installSshTestProvider(connectionId: string, spawn: Mock): void {
  const noopListener = vi.fn(() => () => {})
  const provider = {
    spawn,
    write: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn(),
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    onData: noopListener,
    onReplay: noopListener,
    onExit: noopListener,
    listProcesses: vi.fn(),
    hasChildProcesses: vi.fn(),
    getForegroundProcess: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn(),
    acknowledgeDataEvent: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a fresh SSH spawn calls only spawn and the listener registrations defined above.
  const relay = provider as unknown as Parameters<typeof registerSshPtyProvider>[1]
  registerSshPtyProvider(connectionId, relay)
}

const PROVIDER_FACT_KEYS = [
  'command',
  'cwd',
  'cols',
  'rows',
  'shellOverride',
  'terminalShellArgs',
  'terminalWindowsWslDistro',
  'commandDelivery',
  'startupCommandDelivery'
] as const

// The agent and caller env keys the tables save; their values must reach the provider.
const CASE_ENV_KEYS = ['A', 'CUSTOM_FLAG']

/**
 * The launch facts the plan names at the provider boundary: `orcaEnv` lists identity keys present,
 * `env` the case's own env values, `hidden` whether main marked the PTY hidden before a view.
 */
export async function providerFacts(provider: Mock): Promise<Record<string, unknown>> {
  const options = recordOf(provider.mock.calls.at(-1)?.[0])
  const env = recordOf(options.env)
  const spawned = recordOf(await provider.mock.results.at(-1)?.value)
  return {
    ...Object.fromEntries(
      PROVIDER_FACT_KEYS.filter((k) => k in options).map((k) => [k, options[k]])
    ),
    orcaEnv: IDENTITY_ENV_KEYS.filter((key) => key in env),
    env: Object.fromEntries(CASE_ENV_KEYS.filter((key) => key in env).map((k) => [k, env[k]])),
    hidden: isHiddenRendererPty(String(spawned.id))
  }
}

export function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? { ...value } : {}
}
