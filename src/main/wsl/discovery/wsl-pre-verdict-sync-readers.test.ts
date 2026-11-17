import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSpec } from '@orca/process-host/process-spec'

const { run, sync, registry, hostPrepare, guestPrepare } = vi.hoisted(() => ({
  run: vi.fn(),
  sync: vi.fn(),
  registry: { keys: new Set<string>(), unloadable: false },
  hostPrepare: vi.fn(async () => ({ configDir: 'HOST', envPatch: { CLAUDE_CONFIG_DIR: 'HOST' } })),
  guestPrepare: vi.fn(async () => ({
    configDir: 'GUEST',
    envPatch: { CLAUDE_CONFIG_DIR: 'GUEST' }
  }))
}))

vi.mock('../../windows/windows-native-registry', () => ({
  loadWindowsNativeRegistry: () => {
    if (registry.unloadable) {
      throw new Error('addon missing')
    }
    return {
      HK: { CU: 1, LM: 2 },
      getRegistryKey: (root: number, path: string) =>
        root === 2 && registry.keys.has(path) ? {} : null
    }
  }
}))
vi.mock('@orca/process-host', () => ({ runProcess: run, runProcessSync: sync }))
vi.mock('../execution/wsl-interop-spawn-directory', () => ({
  resolveWslInteropSpawnCwd: () => 'C:\\Windows'
}))
vi.mock('./wsl-registered-distro-fallback', () => ({
  listedOrRegisteredWslDistros: async (listed: string[]) => listed,
  readRegisteredWslDistrosLater: () => {},
  isWslListOutputLost: () => false,
  resetWslListOutputLost: () => {},
  runningWhenListedNone: async () => []
}))
vi.mock('../../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/tmp/orca-pre-verdict-test' })
}))
vi.mock('../../claude-accounts/profiles/routing/claude-profile-router', () => ({
  ClaudeProfileRouter: class {
    publish(): void {}
    prepareLaunch = hostPrepare
  }
}))
vi.mock('../../claude-accounts/profiles/wsl/claude-profile-wsl-router', () => ({
  ClaudeWslProfileRouter: class {
    async runningDistros(): Promise<string[]> {
      return []
    }
    prepareLaunch = guestPrepare
  }
}))
vi.mock('../../claude-accounts/profiles/routing/claude-profile-installed-router', () => ({
  installClaudeObservedConfigDirs: () => {},
  installClaudeProfileRouter: () => {},
  installClaudeWslProfileRouter: () => {}
}))
vi.mock('../../claude-accounts/profiles/routing/claude-observed-config-dirs', () => ({
  ClaudeObservedConfigDirs: class {}
}))

import { getDefaultSettings } from '../../../shared/orca-profiles/constants'
import { _resetWslCachesForTests, getWslHome } from './distro-catalog'
import { ClaudeRuntimeAuthService } from '../../claude-accounts/runtime-auth-service'
import { resolveWslSessionContext } from '../../daemon/pty-subprocess/wsl-session-context'

const originalPlatform = process.platform
const exited = (stdout: string, code = 0) => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})
const isServiceQuery = (spec: ProcessSpec): boolean => /sc\.exe$/i.test(spec.program)
const isWslExe = (spec: ProcessSpec): boolean => /wsl\.exe$/i.test(spec.program)

// The service query never answers here: every read below runs before the verdict.
function hostWithPendingServiceQuery(): void {
  run.mockImplementation((spec: ProcessSpec) =>
    isServiceQuery(spec) ? new Promise(() => {}) : Promise.resolve(exited('Ubuntu\n'))
  )
  sync.mockImplementation((spec: ProcessSpec) =>
    isServiceQuery(spec) ? exited('', 0) : exited('Ubuntu\n')
  )
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  _resetWslCachesForTests()
  registry.keys = new Set()
  registry.unloadable = false
  hostWithPendingServiceQuery()
})

afterEach(() => {
  _resetWslCachesForTests()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  run.mockReset()
  sync.mockReset()
})

const SERVICES = 'SYSTEM\\CurrentControlSet\\Services\\'

describe.each(['WSLService', 'LxssManager'])('only the %s service key is registered', (name) => {
  beforeEach(() => {
    registry.keys = new Set([SERVICES + name])
  })

  it('routes a default-WSL Claude launch to the WSL account before sc.exe answers', async () => {
    const service = new ClaudeRuntimeAuthService({
      getSettings: () => ({
        ...getDefaultSettings('C:\\Users\\user'),
        localAccountRuntime: 'wsl',
        localAccountWslDistro: null
      })
    })
    const first = await service.prepareForClaudeLaunch({ runtime: 'wsl', wslDistro: null })
    expect(first.configDir).toBe('GUEST')
  })

  it('resolves the default distro for a session before sc.exe answers', () => {
    // The stopped-distro hold, guest cwd and history isolation all key off this distro.
    expect(resolveWslSessionContext({ shellOverride: 'wsl.exe', cwd: 'C:\\repo' })?.distro).toBe(
      'Ubuntu'
    )
    // A registered key is the verdict: no sc.exe needed.
    expect(run.mock.calls.map(([spec]) => spec).filter(isServiceQuery)).toEqual([])
  })
})

it.each([
  ['no WSL service key exists', () => {}],
  [
    'the registry addon cannot load',
    () => {
      registry.unloadable = true
    }
  ]
])('never spawns wsl.exe before sc.exe answers when %s', (_label, arrange) => {
  arrange()
  expect(resolveWslSessionContext({ shellOverride: 'wsl.exe', cwd: 'C:\\repo' })).toBeUndefined()
  expect(getWslHome('Ubuntu')).toBeNull()
  expect(sync.mock.calls.map(([spec]) => spec).filter(isWslExe)).toEqual([])
  expect(run.mock.calls.map(([spec]) => spec).filter(isWslExe)).toEqual([])
})
