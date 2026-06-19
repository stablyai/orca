import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, openComputerUsePermissionsMock, getComputerUsePermissionStatusMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    openComputerUsePermissionsMock: vi.fn(),
    getComputerUsePermissionStatusMock: vi.fn()
  }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('../computer/macos-computer-use-permissions', () => ({
  getComputerUsePermissionStatus: getComputerUsePermissionStatusMock,
  openComputerUsePermissions: openComputerUsePermissionsMock
}))

import { registerComputerUsePermissionHandlers } from './computer-use-permissions'

describe('registerComputerUsePermissionHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    getComputerUsePermissionStatusMock.mockReset()
    openComputerUsePermissionsMock.mockReset()
  })

  it('launches the computer-use helper setup', async () => {
    const result = {
      platform: 'darwin',
      helperAppPath: '/Applications/Orca Computer Use.app',
      permissionId: 'accessibility',
      openedSettings: false,
      launchedHelper: true
    }
    openComputerUsePermissionsMock.mockReturnValue(result)

    registerComputerUsePermissionHandlers()

    const registration = handleMock.mock.calls.find(
      ([channel]) => channel === 'computerUsePermissions:openSetup'
    )
    expect(registration).toBeTruthy()

    await expect(registration![1](null, { id: 'accessibility' })).resolves.toBe(result)
    expect(openComputerUsePermissionsMock).toHaveBeenCalledWith('accessibility')
  })

  it('returns computer-use permission status', async () => {
    const result = {
      platform: 'darwin',
      permissions: [
        { id: 'accessibility', status: 'granted' },
        { id: 'screenshots', status: 'not-granted' }
      ]
    }
    getComputerUsePermissionStatusMock.mockReturnValue(result)

    registerComputerUsePermissionHandlers()

    const registration = handleMock.mock.calls.find(
      ([channel]) => channel === 'computerUsePermissions:getStatus'
    )
    expect(registration).toBeTruthy()

    await expect(registration![1]()).resolves.toBe(result)
    expect(getComputerUsePermissionStatusMock).toHaveBeenCalledWith()
  })
})
