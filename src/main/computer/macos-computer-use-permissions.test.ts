import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSpawnDispatch } from '../../shared/__fixtures__/fake-spawned-child'
import { resetComputerUsePermissions } from './macos-computer-use-permissions'
import { getComputerUsePermissionStatus } from './macos-computer-use-permission-status'
import type * as permissionStatusGateModule from './macos-computer-use-permission-status-gate'
import {
  createPermissionStatusGate,
  type PermissionStatusGate
} from './macos-computer-use-permission-status-gate'

const resolveHelperAppPathMock = vi.hoisted(() => vi.fn())
const resolveHelperExecutablePathMock = vi.hoisted(() => vi.fn())
const permissionStatusTempDir = '/tmp/orca-computer-use-permissions-test'
const helperAppPath = '/Applications/Orca Computer Use.app'
let monotonicOffset = 0
const gate = vi.hoisted((): { current: PermissionStatusGate | null } => ({ current: null }))

// A fresh gate per test so one test's floor or cached grant never leaks into the next.
vi.mock('./macos-computer-use-permission-status-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof permissionStatusGateModule>()),
  computerUsePermissionStatusGate: {
    read: () => gate.current!.read(),
    peek: () => gate.current!.peek(),
    invalidate: () => gate.current!.invalidate()
  }
}))

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn()
}))

vi.mock('fs/promises', () => ({
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn()
}))

vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: resolveHelperAppPathMock,
  resolveMacOSComputerUseExecutablePath: resolveHelperExecutablePathMock
}))

describe('setup helper launch window', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.mocked(spawn)
      .mockReset()
      .mockImplementation(fakeSpawnDispatch(() => ({})))
    vi.mocked(spawnSync).mockClear()
    vi.mocked(mkdtemp).mockResolvedValue(permissionStatusTempDir)
    vi.mocked(stat).mockResolvedValue({} as Awaited<ReturnType<typeof stat>>)
    resolveHelperAppPathMock.mockReturnValue(helperAppPath)
    resolveHelperExecutablePathMock.mockReturnValue(
      `${helperAppPath}/Contents/MacOS/orca-computer-use-macos`
    )
    mockPermissionStatus('{"accessibility":"not-granted","screenshots":"not-granted"}')
    setPlatform('darwin')
    vi.useFakeTimers()
    vi.advanceTimersByTime((monotonicOffset += 600_000))
    gate.current = createPermissionStatusGate(getComputerUsePermissionStatus)
  })

  afterEach(async () => {
    // Drain any queued launch so it cannot carry into the next test.
    await vi.advanceTimersByTimeAsync(5_000)
    vi.useRealTimers()
    setPlatform(originalPlatform)
  })

  it('never serves a seeded grant after a partial reset failure', async () => {
    mockPermissionStatus('{"accessibility":"granted","screenshots":"granted"}')
    await gate.current!.read()
    vi.mocked(spawn).mockImplementation(
      fakeSpawnDispatch((program, args) =>
        program === '/usr/bin/tccutil' && args[1] === 'ScreenCapture' ? { code: 1 } : {}
      )
    )
    await expect(resetComputerUsePermissions()).rejects.toThrow('Could not reset ScreenCapture')

    mockPermissionStatus('{"accessibility":"not-granted","screenshots":"granted"}')
    const afterReset = gate.current!.read()
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(afterReset).resolves.toMatchObject({
      permissions: expect.arrayContaining([{ id: 'accessibility', status: 'not-granted' }])
    })
  })
})

function mockPermissionStatus(json: string): void {
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
  vi.mocked(readFile).mockResolvedValue(json)
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}
