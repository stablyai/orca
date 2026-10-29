import { createPaneBindingStore } from './pty-launch-race-test-fixture'
// Real runtime and IPC handlers share one fake provider; suites declare their own hoisted module mocks.
import { vi } from 'vitest'
import type { Project } from '../../../shared/project-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Mock } from 'vitest'
import { registerPtyHandlers } from './register-handlers'
import { existsSyncMock, statSyncMock } from './pty-ipc-mock-registry'
import type { PtyIpcSuiteFixtures } from './pty-ipc-test-harness'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { TerminalWorkspaceLaunchScope } from '../../runtime/runtime-legacy-worker-terminal-recovery-types'
import {
  IDENTITY_ENV_KEYS,
  launchWorkspaceId,
  type LaunchWorkspace
} from '../../../shared/launch-parity-window-request.test-fixture'
import { isHiddenRendererPty } from './delivery/pty-hidden-delivery-gate'
import { HOST_TAB_ID } from './pty-launch-parity-host.test-cases'
import {
  partialRuntimeStore,
  storeProject,
  storeProjectGroup,
  storeWorktreeMeta
} from '../../runtime/runtime-store-partial-fixture'

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

function parityMainSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    // Windows hides the default-shell setting and defaults it to ''.
    terminalDefaultShell: process.platform === 'win32' ? '' : '/bin/zsh',
    terminalDefaultShellArgs: ['-l'],
    terminalWindowsShell: 'powershell.exe',
    terminalWindowsPowerShellImplementation: 'auto',
    disabledTuiAgents: [],
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    // Avoid writing trust state into real agent homes during launch preparation.
    agentWorkspaceTrustEnabled: false,
    ...overrides
  }
}

function launchScope(workspace: LaunchWorkspace): TerminalWorkspaceLaunchScope {
  const connectionId = null
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
  store: ReturnType<typeof createPaneBindingStore>
  runtime: OrcaRuntimeService
  provider: Mock
  persistPtyBinding: Mock
  reveal: Mock
  spawnWindow: (request: Record<string, unknown>) => Promise<unknown>
}

export function startParityLanes(
  suite: Pick<PtyIpcSuiteFixtures, 'handlers' | 'mainWindow' | 'installDaemonTestProvider'>,
  args: {
    workspace: LaunchWorkspace
    settings?: Record<string, unknown>
    spawnError?: Error
    projects?: Pick<Project, 'id' | 'sourceRepoIds' | 'localWindowsRuntimePreference'>[]
    legacyMeta?: { projectId: string; hostId: ExecutionHostId }
    localMeta?: { projectId: string; hostId: ExecutionHostId }
  }
): ParityLanes {
  const settings = parityMainSettings(args.settings)
  const bindingStore = createPaneBindingStore()
  const persistPtyBinding = bindingStore.bindingWrites
  const { repo: scopeRepo, folderWorkspace } = launchScope(args.workspace)
  // Persist a folder's contained repo too so runtime borrowing is exercised.
  const repo =
    scopeRepo ??
    (args.workspace.repoPath
      ? launchScope({ kind: 'repo', path: args.workspace.repoPath }).repo
      : null)
  const store = {
    ...bindingStore,
    getSettings: () => settings,
    getProjects: () =>
      args.projects?.map((project) => storeProject(project)) ?? [
        storeProject({
          id: 'project-1',
          sourceRepoIds: ['repo-1'],
          ...(args.workspace.projectRuntime
            ? { localWindowsRuntimePreference: args.workspace.projectRuntime }
            : {})
        })
      ],
    getRepo: (id: string) => (repo && id === repo.id ? repo : undefined),
    getRepos: () => (repo ? [repo] : []),
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => (args.legacyMeta ? storeWorktreeMeta(args.legacyMeta) : undefined),
    getWorktreeMetaForHost: (_id: string, host: ExecutionHostId) =>
      host === 'local' && args.localMeta ? storeWorktreeMeta(args.localMeta) : undefined,
    getFolderWorkspace: () => folderWorkspace ?? undefined,
    getFolderWorkspaces: () => (folderWorkspace ? [folderWorkspace] : []),
    getProjectGroups: () => [
      storeProjectGroup({ id: 'pg-1', name: 'group', parentPath: null, connectionId: null })
    ]
  }
  const runtime = new OrcaRuntimeService(partialRuntimeStore(store))
  const provider = vi.fn(async (options: { sessionId?: string }) => {
    if (args.spawnError) {
      throw args.spawnError
    }
    // Unique IDs keep hidden marks from leaking across cases.
    return {
      id: options.sessionId ?? `remote-pty-${++remoteSpawns}`,
      startupCwdSource: 'request' as const
    }
  })
  suite.installDaemonTestProvider({ spawn: provider })
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
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  return {
    store,
    runtime,
    provider,
    persistPtyBinding,
    reveal,
    spawnWindow: async (request) => suite.handlers.get('pty:spawn')!(null, request)
  }
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

const CASE_ENV_KEYS = ['A', 'CUSTOM_FLAG']

/** Capture provider identity, requested environment and pre-view hidden state at the spawn boundary. */
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

export async function spawnBoth(
  lanes: ParityLanes,
  workspace: LaunchWorkspace,
  window: Record<string, unknown>,
  host: Record<string, unknown> = {}
): Promise<Record<'window' | 'host', Record<string, unknown>>> {
  const worktreeId = launchWorkspaceId(workspace)
  const result = recordOf(
    await lanes.spawnWindow({ cols: 80, rows: 24, cwd: workspace.path, worktreeId, ...window })
  )
  const windowFacts = { ...(await providerFacts(lanes.provider)), result }
  const created = recordOf(await lanes.runtime.createTerminal(`id:${worktreeId}`, host))
  return { window: windowFacts, host: { ...(await providerFacts(lanes.provider)), created } }
}
