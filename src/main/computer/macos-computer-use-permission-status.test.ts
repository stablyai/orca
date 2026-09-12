import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getComputerUsePermissionStatus } from './macos-computer-use-permission-status'

const { statusMock, appPathMock, executablePathMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  appPathMock: vi.fn(),
  executablePathMock: vi.fn()
}))

vi.mock('./sidecar-client', () => ({ callComputerSidecarPermissionStatus: statusMock }))
vi.mock('./macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: appPathMock,
  resolveMacOSComputerUseExecutablePath: executablePathMock
}))

const originalPlatform = process.platform
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  appPathMock.mockReturnValue('/Applications/Orca Computer Use.app')
  executablePathMock.mockReturnValue(
    '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
  )
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
})

describe('execution-process permission status', () => {
  it('reports execution denial even when a separately launched helper could be authorized', async () => {
    statusMock.mockResolvedValue({ accessibility: 'not-granted', screenshots: 'granted' })
    await expect(getComputerUsePermissionStatus()).resolves.toMatchObject({
      helperUnavailableReason: null,
      permissions: [
        { id: 'accessibility', status: 'not-granted' },
        { id: 'screenshots', status: 'granted' }
      ]
    })
    expect(statusMock).toHaveBeenCalledOnce()
  })

  it('refreshes execution status after a permission change', async () => {
    statusMock
      .mockResolvedValueOnce({ accessibility: 'not-granted', screenshots: 'not-granted' })
      .mockResolvedValueOnce({ accessibility: 'granted', screenshots: 'granted' })
    await getComputerUsePermissionStatus()
    expect(
      (await getComputerUsePermissionStatus()).permissions.every((p) => p.status === 'granted')
    ).toBe(true)
    expect(statusMock).toHaveBeenCalledTimes(2)
  })

  it.each(['unsupported_capability', 'accessibility_error', 'action_timeout'])(
    'preserves %s instead of probing another process',
    async (code) => {
      const error = Object.assign(new Error('execution probe failed'), { code })
      statusMock.mockRejectedValue(error)
      await expect(getComputerUsePermissionStatus()).rejects.toBe(error)
    }
  )

  it.each(['app', 'executable'])(
    'does not start the sidecar when the %s is missing',
    async (missing) => {
      if (missing === 'app') {
        appPathMock.mockReturnValue(null)
      } else {
        executablePathMock.mockReturnValue(null)
      }
      expect((await getComputerUsePermissionStatus()).helperUnavailableReason).toContain(
        'was not found'
      )
      expect(statusMock).not.toHaveBeenCalled()
    }
  )

  it.each(['linux', 'win32'])('does not start a macOS provider on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    expect(
      (await getComputerUsePermissionStatus()).permissions.every((p) => p.status === 'unsupported')
    ).toBe(true)
    expect(statusMock).not.toHaveBeenCalled()
  })
})
