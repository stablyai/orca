import type * as WslGate from '../wsl/wsl-unc-access-gate'
import { afterEach, expect, it, vi } from 'vitest'
import { FilesystemHostReadAuthority } from './filesystem-host-read-authority'
import { FilesystemHostSupervisor } from './filesystem-host-supervisor'
import { FilesystemHostProcessError } from './filesystem-host-process'
import {
  configureFilesystemHostReadAuthority,
  setFilesystemHostReadClientForTests
} from './filesystem-host-read-client'
import { attachFilesystemHostRuntimeCatalog } from './filesystem-host-runtime-catalog'
import { WslDistroStoppedError, WslDistroUnverifiableError } from '../wsl/wsl-unc-access-gate'

vi.hoisted(() => vi.resetModules())

const gate = vi.hoisted(() => ({ assertRunning: vi.fn(async (_path: string) => {}) }))
vi.mock('../wsl/wsl-unc-access-gate', async (original) => ({
  ...(await original<typeof WslGate>()),
  assertWslUncPathRunning: gate.assertRunning
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({
    getPath: (name: string) => (name === 'home' ? '/home' : '/user-data')
  })
}))

afterEach(() => {
  setFilesystemHostReadClientForTests(null)
  vi.useRealTimers()
  gate.assertRunning.mockReset().mockResolvedValue(undefined)
})

it('hydrates and reconciles server/local folder roots, isolates failed mounts, and excludes remote owners', async () => {
  const classified: string[] = []
  const supervisor = new FilesystemHostSupervisor({
    entryPath: 'unused',
    startProcess: async (options) => ({
      invoke: async (operation) => {
        if (operation.kind === 'classify-path') {
          classified.push(operation.path)
          return { kind: 'classify-path', deviceId: operation.path }
        }
        if (operation.path.startsWith('/bad/')) {
          throw new FilesystemHostProcessError('deadline', 'mount unavailable')
        }
        return { kind: 'canonicalize-path', canonicalPath: operation.path }
      },
      retire: async () => {
        options.onPhysicalExit?.()
        return true
      }
    })
  })
  const authority = new FilesystemHostReadAuthority({ entryPath: 'unused', supervisor })
  configureFilesystemHostReadAuthority(authority)
  let repos = [
    { path: '/bad' },
    { path: '/healthy-folder' },
    { path: '/ssh', executionHostId: 'ssh:connection' },
    { path: '/legacy-remote', connectionId: 'connection' }
  ]
  let notify: (event: { type: string }) => void = () => {}
  const detach = attachFilesystemHostRuntimeCatalog({
    getRepos: () => repos,
    onClientEvent: (listener) => {
      notify = listener
      return () => {
        notify = () => {}
      }
    }
  })
  try {
    await vi.waitFor(() => expect(classified).toHaveLength(4))
    expect(classified).toEqual(
      expect.arrayContaining(['/home', '/user-data', '/bad', '/healthy-folder'])
    )
    await expect(authority.canonicalizePath('/bad/file')).rejects.toMatchObject({
      code: 'ETIMEDOUT'
    })
    await expect(authority.canonicalizePath('/healthy-folder/file')).resolves.toBe(
      '/healthy-folder/file'
    )
    repos = [{ path: '/new-folder' }]
    const remove = vi.spyOn(supervisor, 'removeFailureDomain')
    notify({ type: 'reposChanged' })
    await vi.waitFor(() => expect(classified).toContain('/new-folder'))
    expect(remove).toHaveBeenCalledWith({ executionHost: 'native', prefix: '/bad' })
    expect(remove).toHaveBeenCalledWith({ executionHost: 'native', prefix: '/healthy-folder' })
  } finally {
    detach()
    await authority.dispose()
  }
})

it.each([
  ['stopped', WslDistroStoppedError],
  ['unverifiable', WslDistroUnverifiableError]
] as const)(
  'never classifies or reads a %s WSL root, and retries safely after it runs',
  async (_state, BlockedError) => {
    vi.useFakeTimers()
    const stopped = '\\\\wsl.localhost\\Ubuntu\\home\\repo'
    const running = '\\\\wsl.localhost\\Debian\\home\\repo'
    let blocked = true
    gate.assertRunning.mockImplementation(async (path) => {
      if (path === stopped && blocked) {
        throw new BlockedError('Ubuntu')
      }
    })
    const dispatch = vi.fn<FilesystemHostSupervisor['dispatch']>(async (input) => ({
      kind: 'classify-path',
      deviceId: input.operation.path
    }))
    const authority = new FilesystemHostReadAuthority({
      entryPath: 'unused',
      platform: 'win32',
      supervisor: {
        dispatch,
        publishFailureDomain: vi.fn(),
        removeFailureDomain: vi.fn(),
        dispose: async () => {}
      }
    })
    configureFilesystemHostReadAuthority(authority)
    const detach = attachFilesystemHostRuntimeCatalog({
      getRepos: () => [{ path: stopped }, { path: running }, { path: 'C:\\native' }],
      onClientEvent: () => () => {}
    })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(dispatch.mock.calls.map(([input]) => input.operation.path)).toEqual(
        expect.arrayContaining(['/home', '/user-data', running, 'C:\\native'])
      )
      expect(dispatch.mock.calls.some(([input]) => input.operation.path === stopped)).toBe(false)
      const read = authority.readOrcaYaml(`${stopped}/orca.yaml`).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(0)
      expect(await read).toMatchObject({ name: 'FilesystemHostReadError' })
      expect(dispatch.mock.calls.some(([input]) => input.operation.path.startsWith(stopped))).toBe(
        false
      )
      blocked = false
      await vi.advanceTimersByTimeAsync(100)
      expect(dispatch.mock.calls.some(([input]) => input.operation.path === stopped)).toBe(true)
    } finally {
      detach()
      await authority.dispose()
    }
  }
)
