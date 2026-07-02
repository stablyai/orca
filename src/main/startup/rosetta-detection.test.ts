import { afterEach, describe, expect, it, vi } from 'vitest'

const { appMock, execFileSyncMock } = vi.hoisted(() => ({
  appMock: {} as { runningUnderARM64Translation?: boolean },
  execFileSyncMock: vi.fn()
}))

vi.mock('electron', () => ({ app: appMock }))
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))

import { isRunningTranslatedOnAppleSilicon } from './rosetta-detection'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  delete appMock.runningUnderARM64Translation
  execFileSyncMock.mockReset()
})

describe('isRunningTranslatedOnAppleSilicon', () => {
  it('is false off macOS, without probing', () => {
    setPlatform('linux')
    appMock.runningUnderARM64Translation = true
    expect(isRunningTranslatedOnAppleSilicon()).toBe(false)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('trusts the Electron translation flag when present (true)', () => {
    setPlatform('darwin')
    appMock.runningUnderARM64Translation = true
    expect(isRunningTranslatedOnAppleSilicon()).toBe(true)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('trusts the Electron translation flag when present (false)', () => {
    setPlatform('darwin')
    appMock.runningUnderARM64Translation = false
    expect(isRunningTranslatedOnAppleSilicon()).toBe(false)
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('falls back to sysctl when the flag is absent — translated', () => {
    setPlatform('darwin')
    execFileSyncMock.mockReturnValue('1\n')
    expect(isRunningTranslatedOnAppleSilicon()).toBe(true)
  })

  it('falls back to sysctl when the flag is absent — native', () => {
    setPlatform('darwin')
    execFileSyncMock.mockReturnValue('0\n')
    expect(isRunningTranslatedOnAppleSilicon()).toBe(false)
  })

  it('treats a sysctl failure as native (false)', () => {
    setPlatform('darwin')
    execFileSyncMock.mockImplementation(() => {
      throw new Error('sysctl: unknown oid')
    })
    expect(isRunningTranslatedOnAppleSilicon()).toBe(false)
  })
})
