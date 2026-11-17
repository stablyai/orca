import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type { ProcessSpec } from '@orca/process-host/process-spec'

const { run, sync, disk, hostPrepare, guestPrepare } = vi.hoisted(() => ({
  run: vi.fn(),
  sync: vi.fn(),
  disk: { wslBinaries: true },
  hostPrepare: vi.fn(async () => ({ configDir: 'HOST', envPatch: { CLAUDE_CONFIG_DIR: 'HOST' } })),
  guestPrepare: vi.fn(async () => ({
    configDir: 'GUEST',
    envPatch: { CLAUDE_CONFIG_DIR: 'GUEST' }
  }))
}))

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>()
  const existsSync = (path: Parameters<typeof fs.existsSync>[0]): boolean =>
    /(LxssManager\.dll|wslservice\.exe)$/i.test(String(path))
      ? disk.wslBinaries
      : fs.existsSync(path)
  return { ...fs, default: { ...fs, existsSync }, existsSync }
})
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
import { _resetWslCachesForTests } from './distro-catalog'
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
  disk.wslBinaries = true
  hostWithPendingServiceQuery()
})

afterEach(() => {
  _resetWslCachesForTests()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  run.mockReset()
  sync.mockReset()
})

it('routes a default-WSL Claude launch to the WSL account before the service verdict', async () => {
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

it('resolves the default distro for a session before the service verdict', () => {
  // The stopped-distro hold, guest cwd and history isolation all key off this distro.
  expect(resolveWslSessionContext({ shellOverride: 'wsl.exe', cwd: 'C:\\repo' })?.distro).toBe(
    'Ubuntu'
  )
})

it('never spawns wsl.exe before the verdict when no WSL service binary is on disk', () => {
  disk.wslBinaries = false
  expect(resolveWslSessionContext({ shellOverride: 'wsl.exe', cwd: 'C:\\repo' })).toBeUndefined()
  expect(sync.mock.calls.map(([spec]) => spec).filter(isWslExe)).toEqual([])
  expect(run.mock.calls.map(([spec]) => spec).filter(isWslExe)).toEqual([])
})
