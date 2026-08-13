import { afterEach, describe, expect, it, vi } from 'vitest'

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock
}))

import { getWindowsProgramsPath } from './windows-programs-path'

describe('Windows Programs path', () => {
  const originalResourcesPath = process.resourcesPath

  afterEach(() => {
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: originalResourcesPath
    })
  })

  it('bounds the native bridge while accepting an arbitrarily named redirected folder', () => {
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: 'C:\\Program Files\\Orca\\resources'
    })
    execFileSyncMock.mockReturnValue('D:\\Company Shell\\Launchers\n')

    expect(getWindowsProgramsPath()).toBe('D:\\Company Shell\\Launchers')
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'C:\\Program Files\\Orca\\resources\\bin\\orca-programs-path.exe',
      {
        encoding: 'utf8',
        timeout: 1_000,
        windowsHide: true
      }
    )
  })
})
