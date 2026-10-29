import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { describeWslUncAccessDenied } from './wsl-unc-access-denied'

const DRIVE = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`

function failing(code: string) {
  return async () => {
    throw Object.assign(new Error(code), { code })
  }
}

const originalPlatform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  vi.unstubAllEnvs()
})

describe('describeWslUncAccessDenied', () => {
  it.each(['EPERM', 'EACCES'])('names a WSL path Windows refused with %s', async (code) => {
    expect(await describeWslUncAccessDenied(DRIVE, failing(code))).toBe(
      `Windows denied access to this WSL path: ${DRIVE}`
    )
  })

  it('leaves other failures, readable paths and non-WSL paths to the usual message', async () => {
    expect(await describeWslUncAccessDenied(DRIVE, failing('ENOENT'))).toBeNull()
    expect(await describeWslUncAccessDenied(DRIVE, async () => [])).toBeNull()
    expect(await describeWslUncAccessDenied(String.raw`C:\src\app`, failing('EPERM'))).toBeNull()
  })

  it('keeps the usual message, without listing the folder, while WSL hosts are off', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '')
    const list = vi.fn(failing('EPERM'))
    expect(await describeWslUncAccessDenied(DRIVE, list)).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })
})
