import { vi } from 'vitest'
import { Store } from '../../persistence'
import type { LocalWindowsRuntimePreference } from '../../../shared/project-execution-runtime'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import type { TuiAgent } from '../../../shared/tui-agent'
import { registerPtyHandlers } from './register-handlers'
import { setLocalPtyProvider } from './provider/registry'

type IpcHandlerMap = Map<string, (_event: unknown, args: unknown) => unknown>

export type DaemonSpawnCall = {
  env: Record<string, string>
  envToDelete?: string[]
  isNewSession?: boolean
  shellOverride?: string
  terminalWindowsWslDistro?: string | null
  terminalWindowsPowerShellImplementation?: string
}

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
    projectRuntimePreference: LocalWindowsRuntimePreference
    settings?: Partial<GlobalSettings>
  }): Store {
    const store = vi.mockObject(Store.prototype)
    const repo = { id: 'repo-1', path: 'C:\\repo', displayName: 'repo', badgeColor: '', addedAt: 0 }
    store.getRepo.mockImplementation((repoId) => (repoId === repo.id ? repo : undefined))
    store.getRepos.mockReturnValue([repo])
    store.getProjects.mockReturnValue([
      {
        id: 'project-1',
        displayName: 'project',
        badgeColor: '',
        sourceRepoIds: ['repo-1'],
        localWindowsRuntimePreference: args.projectRuntimePreference,
        createdAt: 0,
        updatedAt: 0
      }
    ])
    store.getSettings.mockReturnValue(
      createGlobalSettingsFixture({
        localWindowsRuntimeDefault: { kind: 'windows-host' },
        ...args.settings
      })
    )
    return store
  }

  async function daemonSpawnAndGetOptions(
    argsEnv?: Record<string, string>,
    getSelectedCodexHomePath?: (
      target?: { runtime?: 'host' | 'wsl'; wslDistro?: string | null },
      launchEnv?: NodeJS.ProcessEnv,
      launchContext?: { unavailableManagedHomePath?: string }
    ) => string | null,
    getSettings?: () => {
      httpProxyUrl?: string
      httpProxyBypassRules?: string
    },
    processEnvOverrides?: Record<string, string | undefined>,
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
      launchContext?: { unavailableManagedHomePath?: string }
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
