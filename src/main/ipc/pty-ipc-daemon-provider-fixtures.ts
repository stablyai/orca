import { vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'

type IpcHandlerMap = Map<string, (_event: unknown, args: unknown) => unknown>

export type DaemonSpawnCall = {
  env: Record<string, string>
  envToDelete?: string[]
  isNewSession?: boolean
  shellOverride?: string
  terminalWindowsWslDistro?: string | null
  terminalWindowsPowerShellImplementation?: string
}

/** Daemon-backed provider doubles for the "daemon-active provider" spawn-env suites. */
export function createDaemonActiveProviderFixtures(ctx: {
  handlers: IpcHandlerMap
  mainWindow: unknown
}) {
  const { handlers, mainWindow } = ctx
  function setupDaemonAdapter(
    supportsGitCredentialGuardHost = true,
    reportedWslDistro?: string | null,
    supportsAgentSessionClaims = true,
    supportsAgentSessionCreateOperations = supportsAgentSessionClaims
  ) {
    const daemonSpawn = vi.fn(
      async (options: {
        env: Record<string, string>
        sessionId?: string
        isNewSession?: boolean
        agentSessionCreateOperationId?: string
        command?: string
      }) => ({
        id: options.sessionId ?? 'daemon-pty',
        ...(reportedWslDistro !== undefined ? { wslDistro: reportedWslDistro } : {})
      })
    )
    setLocalPtyProvider({
      spawn: daemonSpawn,
      supportsGitCredentialGuardHost: () => supportsGitCredentialGuardHost,
      supportsAgentSessionClaims: () => supportsAgentSessionClaims,
      supportsAgentSessionCreateOperations: () => supportsAgentSessionCreateOperations,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)
    return daemonSpawn
  }
  async function withWin32Platform<T>(fn: () => Promise<T>): Promise<T> {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    try {
      return await fn()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  }

  function makeProjectRuntimeStore(args: {
    projectRuntimePreference: unknown
    settings?: Record<string, unknown>
  }) {
    const settings = {
      localWindowsRuntimeDefault: { kind: 'windows-host' },
      ...args.settings
    }
    return {
      getRepo: vi.fn((repoId: string) =>
        repoId === 'repo-1' ? { id: 'repo-1', path: 'C:\\repo' } : undefined
      ),
      getProjects: vi.fn(() => [
        {
          id: 'project-1',
          sourceRepoIds: ['repo-1'],
          localWindowsRuntimePreference: args.projectRuntimePreference
        }
      ]),
      getSettings: vi.fn(() => settings)
    }
  }

  async function daemonSpawnAndGetOptions(
    argsEnv?: Record<string, string>,
    getSelectedCodexHomePath?: (
      target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null },
      launchEnv?: NodeJS.ProcessEnv,
      launchContext?: { workspacePath?: string; launchAgent?: TuiAgent }
    ) => string | null,
    getSettings?: () => {
      httpProxyUrl?: string
      httpProxyBypassRules?: string
    },
    processEnvOverrides?: Record<string, string | undefined>,
    // Why: daemon spawn tests exercise both WSL launch metadata from main and PR #2662 command threading for OMP.
    spawnArgs?: {
      cwd?: string
      worktreeId?: string
      shellOverride?: string
      command?: string
      launchAgent?: TuiAgent
      envToDelete?: string[]
    },
    supportsGitCredentialGuardHost = true
  ): Promise<DaemonSpawnCall> {
    const daemonSpawn = setupDaemonAdapter(supportsGitCredentialGuardHost)
    const savedEnv: Record<string, string | undefined> = {}
    if (processEnvOverrides) {
      for (const [k, v] of Object.entries(processEnvOverrides)) {
        savedEnv[k] = process.env[k]
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
    }
    try {
      handlers.clear()
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        getSelectedCodexHomePath,
        getSettings as never
      )
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        ...spawnArgs,
        ...(argsEnv ? { env: argsEnv } : {})
      })
      return daemonSpawn.mock.calls.at(-1)![0] as DaemonSpawnCall
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k]
        } else {
          process.env[k] = v
        }
      }
    }
  }

  async function daemonSpawnAndGetEnv(
    argsEnv?: Record<string, string>,
    getSelectedCodexHomePath?: (
      target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null },
      launchEnv?: NodeJS.ProcessEnv,
      launchContext?: { workspacePath?: string; launchAgent?: TuiAgent }
    ) => string | null,
    getSettings?: () => {
      httpProxyUrl?: string
      httpProxyBypassRules?: string
    },
    processEnvOverrides?: Record<string, string | undefined>,
    spawnArgs?: {
      cwd?: string
      shellOverride?: string
      command?: string
      launchAgent?: TuiAgent
    },
    supportsGitCredentialGuardHost = true
  ): Promise<Record<string, string>> {
    return (
      await daemonSpawnAndGetOptions(
        argsEnv,
        getSelectedCodexHomePath,
        getSettings,
        processEnvOverrides,
        spawnArgs,
        supportsGitCredentialGuardHost
      )
    ).env
  }

  return {
    setupDaemonAdapter,
    withWin32Platform,
    makeProjectRuntimeStore,
    daemonSpawnAndGetOptions,
    daemonSpawnAndGetEnv
  }
}
