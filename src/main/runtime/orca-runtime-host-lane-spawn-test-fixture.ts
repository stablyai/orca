// Light host-lane harness: a real OrcaRuntimeService with a stubbed launch scope and a fake
// ptyController, so createTerminal/createAgentSession run end to end up to `spawn`.
// Each test file must still `vi.mock('electron', ...)` itself.
import { vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

export const TAB_ID = '11111111-1111-4111-8111-111111111111'
export const LEAF_ID = '22222222-2222-4222-8222-222222222222'
export const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
export const POSIX_PATH = '/r/wt'
export const WIN_PATH = 'C:\\r\\wt'
export const WSL_PATH = '\\\\wsl$\\Ubuntu\\r\\wt'
export const PANE_ENV_KEYS = [
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID'
] as const
export const FOLDER_ENV_KEYS = ['ORCA_PROJECT_GROUP_ID', 'ORCA_WORKSPACE_ID', 'ORCA_WORKSPACE_ROOT']

export type WorkspaceKind = 'repo' | 'folder'

export function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

export function workspaceScope(
  kind: WorkspaceKind,
  path: string,
  connectionId: string | null
): TerminalWorkspaceLaunchScope {
  if (kind === 'repo') {
    return {
      id: `repo-1::${path}`,
      path,
      connectionId,
      repo: {
        id: 'repo-1',
        path,
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
    path,
    connectionId,
    repo: null,
    folderWorkspace: {
      id: 'fw-1',
      projectGroupId: 'pg-1',
      name: 'folder',
      folderPath: path,
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

type RuntimeInternals = {
  resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<TerminalWorkspaceLaunchScope>
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
}

export function internalsOf(runtime: OrcaRuntimeService): RuntimeInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both members exist on the runtime (protected); the type names only what these tests read or stub.
  return runtime as unknown as RuntimeInternals
}

export type HostLane = {
  runtime: OrcaRuntimeService
  spawn: ReturnType<typeof vi.fn>
  reveal: ReturnType<typeof vi.fn>
}

export function hostLane(
  scope: TerminalWorkspaceLaunchScope,
  settings: Record<string, unknown> = {}
): HostLane {
  const store = {
    getSettings: () => ({
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      // A local Windows host quotes for cmd.exe, so a WSL/posix quoting choice is visible.
      terminalWindowsShell: 'cmd.exe',
      ...settings
    }),
    getProjects: () => [],
    getRepo: () => undefined,
    getRepos: () => []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create paths read only getSettings/getProjects/getRepo/getRepos from the store; the rest of RuntimeStore is unreachable here.
  const runtime = new OrcaRuntimeService(store as never)
  vi.spyOn(internalsOf(runtime), 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue(scope)
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const reveal = vi.fn().mockResolvedValue({ tabId: TAB_ID })
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
  return { runtime, spawn, reveal }
}

export function spawnArgs(spawn: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return spawn.mock.calls[0]?.[0] ?? {}
}

export function spawnEnv(spawn: ReturnType<typeof vi.fn>): Record<string, string> {
  const env = spawnArgs(spawn).env
  return env && typeof env === 'object' ? { ...env } : {}
}

/** The launch facts every host-lane producer must keep at the spawn boundary. */
export function pickSpawnFacts(args: Record<string, unknown>): Record<string, unknown> {
  return {
    command: args.command,
    cols: args.cols,
    rows: args.rows,
    initiallyHidden: args.initiallyHidden,
    persistHostSessionBinding: args.persistHostSessionBinding,
    placement: args.placement,
    commandDelivery: args.commandDelivery,
    startupCommandDelivery: args.startupCommandDelivery,
    cwd: args.cwd,
    connectionId: args.connectionId,
    launchAgent: args.launchAgent,
    telemetry: args.telemetry
  }
}

export function orcaEnvKeys(spawn: ReturnType<typeof vi.fn>): string[] {
  return Object.keys(spawnEnv(spawn))
    .filter((key) => key.startsWith('ORCA_'))
    .sort()
}

export function expectedOrcaEnvKeys(kind: WorkspaceKind): string[] {
  return [...PANE_ENV_KEYS, ...(kind === 'folder' ? FOLDER_ENV_KEYS : [])].sort()
}
