import { spawn, spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClientError } from './runtime-client-error'

const { callPermissionStatusMock, isMacOS14OrNewerMock, resolveAppMock, resolveExecutableMock } =
  vi.hoisted(() => ({
    callPermissionStatusMock: vi.fn(),
    isMacOS14OrNewerMock: vi.fn(),
    resolveAppMock: vi.fn(),
    resolveExecutableMock: vi.fn()
  }))

vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }))
vi.mock('./sidecar-client', () => ({
  callComputerSidecarPermissionStatus: callPermissionStatusMock
}))
vi.mock('./macos-native-provider-transport', () => ({ isMacOS14OrNewer: isMacOS14OrNewerMock }))
vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: resolveAppMock,
  resolveMacOSComputerUseExecutablePath: resolveExecutableMock
}))

const helperAppPath = '/Applications/Orca.app/Contents/Resources/Orca Computer Use.app'

async function loadModule() {
  vi.resetModules()
  return await import('./macos-computer-use-permission-status')
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('getComputerUsePermissionStatus', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    setPlatform('darwin')
    resolveAppMock.mockReturnValue(helperAppPath)
    resolveExecutableMock.mockReturnValue(`${helperAppPath}/Contents/MacOS/orca-computer-use-macos`)
    isMacOS14OrNewerMock.mockReturnValue(true)
    callPermissionStatusMock.mockResolvedValue({
      accessibility: 'granted',
      screenshots: 'not-granted'
    })
  })

  afterEach(() => {
    setPlatform(originalPlatform)
    vi.clearAllMocks()
  })

  it('reads status from the provider and never launches an app', async () => {
    const { getComputerUsePermissionStatus } = await loadModule()

    await expect(getComputerUsePermissionStatus()).resolves.toEqual({
      platform: 'darwin',
      helperAppPath,
      helperUnavailableReason: null,
      permissions: [
        { id: 'accessibility', status: 'granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    })
    expect(callPermissionStatusMock).toHaveBeenCalledWith(false)
    // Why: LaunchServices probe launches wedged app launches system-wide (#29146).
    expect(spawn).not.toHaveBeenCalled()
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('shares one provider request across concurrent callers', async () => {
    const { getComputerUsePermissionStatus } = await loadModule()
    const reply = deferred<unknown>()
    callPermissionStatusMock.mockReturnValueOnce(reply.promise)

    const reads = Array.from({ length: 4 }, () => getComputerUsePermissionStatus())
    reply.resolve({ accessibility: 'granted', screenshots: 'granted' })
    const results = await Promise.all(reads)

    expect(callPermissionStatusMock).toHaveBeenCalledTimes(1)
    expect(new Set(results).size).toBe(1)

    await getComputerUsePermissionStatus()
    expect(callPermissionStatusMock).toHaveBeenCalledTimes(2)
  })

  it('does not share a read that started before a fresh one', async () => {
    const { getComputerUsePermissionStatus, getFreshComputerUsePermissionStatus } =
      await loadModule()
    const stale = deferred<unknown>()
    callPermissionStatusMock.mockReturnValueOnce(stale.promise)

    const before = getComputerUsePermissionStatus()
    const fresh = getFreshComputerUsePermissionStatus()
    const after = getComputerUsePermissionStatus()
    stale.resolve({ accessibility: 'granted', screenshots: 'granted' })

    await expect(fresh).resolves.toMatchObject({
      permissions: [
        { id: 'accessibility', status: 'granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    })
    await expect(after).resolves.toBe(await fresh)
    await expect(before).resolves.not.toBe(await fresh)
    expect(callPermissionStatusMock.mock.calls).toEqual([[false], [true]])
  })

  it('does not report a grant when the provider read fails', async () => {
    const { getComputerUsePermissionStatus } = await loadModule()
    callPermissionStatusMock.mockRejectedValueOnce(
      new RuntimeClientError('action_timeout', 'computer sidecar permissionStatus timed out')
    )

    await expect(getComputerUsePermissionStatus()).rejects.toThrow('timed out')
    // The failed read must not stay cached for the next caller.
    await expect(getComputerUsePermissionStatus()).resolves.toMatchObject({
      helperUnavailableReason: null
    })
  })

  it('rejects a malformed provider reply instead of guessing', async () => {
    const { getComputerUsePermissionStatus } = await loadModule()
    callPermissionStatusMock.mockResolvedValueOnce({ accessibility: 'granted' })

    await expect(getComputerUsePermissionStatus()).rejects.toThrow('malformed permission status')
  })

  it('reports a provider without the status capability as unavailable', async () => {
    const { getComputerUsePermissionStatus } = await loadModule()
    callPermissionStatusMock.mockRejectedValueOnce(
      new RuntimeClientError(
        'unsupported_capability',
        'native macOS provider does not support permissions.status'
      )
    )

    await expect(getComputerUsePermissionStatus()).resolves.toEqual({
      platform: 'darwin',
      helperAppPath,
      helperUnavailableReason:
        'Orca Computer Use cannot report permissions: native macOS provider does not support permissions.status',
      permissions: [
        { id: 'accessibility', status: 'not-granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    })
  })

  it('reports unsupported macOS versions without starting the provider', async () => {
    const { getComputerUsePermissionStatus } = await loadModule()
    isMacOS14OrNewerMock.mockReturnValue(false)

    await expect(getComputerUsePermissionStatus()).resolves.toMatchObject({
      helperUnavailableReason: 'Orca Computer Use requires macOS 14 or newer'
    })
    expect(callPermissionStatusMock).not.toHaveBeenCalled()
  })

  it('reports a missing helper app without starting the provider', async () => {
    const { getComputerUsePermissionStatus } = await loadModule()
    resolveAppMock.mockReturnValue(null)

    await expect(getComputerUsePermissionStatus()).resolves.toEqual({
      platform: 'darwin',
      helperAppPath: null,
      helperUnavailableReason: 'Orca Computer Use.app was not found',
      permissions: [
        { id: 'accessibility', status: 'not-granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    })
    expect(callPermissionStatusMock).not.toHaveBeenCalled()
  })

  it('reports a missing helper executable without starting the provider', async () => {
    const { getComputerUsePermissionStatus } = await loadModule()
    resolveExecutableMock.mockReturnValue(null)

    await expect(getComputerUsePermissionStatus()).resolves.toMatchObject({
      helperAppPath,
      helperUnavailableReason: `${helperAppPath}/Contents/MacOS/orca-computer-use-macos was not found`
    })
    expect(callPermissionStatusMock).not.toHaveBeenCalled()
  })

  it('returns unsupported permissions off macOS', async () => {
    const { getComputerUsePermissionStatus } = await loadModule()
    setPlatform('linux')

    await expect(getComputerUsePermissionStatus()).resolves.toEqual({
      platform: 'linux',
      helperAppPath: null,
      helperUnavailableReason: null,
      permissions: [
        { id: 'accessibility', status: 'unsupported' },
        { id: 'screenshots', status: 'unsupported' }
      ]
    })
    expect(callPermissionStatusMock).not.toHaveBeenCalled()
  })
})

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}
