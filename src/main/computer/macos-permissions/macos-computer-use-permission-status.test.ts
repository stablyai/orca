import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runningHelperStatusMock, spawnMock } = vi.hoisted(() => ({
  runningHelperStatusMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

vi.mock('../macos-native/macos-native-provider-paths', () => ({
  resolveMacOSComputerUseAppPath: () => '/Applications/Orca Computer Use.app',
  resolveMacOSComputerUseExecutablePath: () =>
    '/Applications/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
}))

vi.mock('../sidecar-transport/sidecar-client', () => ({
  callComputerSidecarPermissionStatus: runningHelperStatusMock
}))

describe('getComputerUsePermissionStatus with a running automation helper', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    runningHelperStatusMock.mockReset()
    spawnMock.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('reports the running helper denial instead of launching a separate helper', async () => {
    runningHelperStatusMock.mockResolvedValue({
      accessibility: 'not-granted',
      screenshots: 'granted'
    })
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permission-status')

    await expect(getComputerUsePermissionStatus()).resolves.toMatchObject({
      permissions: [
        { id: 'accessibility', status: 'not-granted' },
        { id: 'screenshots', status: 'granted' }
      ]
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('surfaces a running helper probe failure rather than a separate helper grant', async () => {
    runningHelperStatusMock.mockRejectedValue(new Error('automation worker unavailable'))
    const { getComputerUsePermissionStatus } = await import('./macos-computer-use-permission-status')

    await expect(getComputerUsePermissionStatus()).rejects.toThrow('automation worker unavailable')
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
