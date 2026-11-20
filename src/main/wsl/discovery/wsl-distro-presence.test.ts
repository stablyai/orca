import type { ProcessSpec } from '@orca/process-host/process-spec'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanUpUnlessWslDistroGone } from './wsl-distro-presence'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))

type Answer = { code: number | null; stdout: string } | Error
let wslList: Answer
let registry: Answer

const REGISTRY_WITH_UBUNTU = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{11111111-2222-3333-4444-555555555555}',
  '    DistributionName    REG_SZ    Ubuntu',
  ''
].join('\r\n')

function enoent(): Error {
  return Object.assign(new Error('spawn wsl.exe ENOENT'), { code: 'ENOENT' })
}

const cleanupError = new Error('WSL Ubuntu: exited with 1')
const failedCleanup = () => cleanUpUnlessWslDistroGone('Ubuntu', () => Promise.reject(cleanupError))

beforeEach(() => {
  runProcess.mockReset()
  runProcess.mockImplementation(async (spec: ProcessSpec) => {
    const answer = spec.program === 'wsl.exe' ? wslList : registry
    if (answer instanceof Error) {
      throw answer
    }
    return { ...answer, stderr: '', timedOut: false, signal: null }
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a failed WSL account cleanup', () => {
  it('stands while the distro is still installed', async () => {
    wslList = { code: 0, stdout: 'Ubuntu\r\nDebian\r\n' }
    await expect(failedCleanup()).rejects.toBe(cleanupError)

    // Lost list output: the registry still holds the distro.
    wslList = { code: 0, stdout: '' }
    registry = { code: 0, stdout: REGISTRY_WITH_UBUNTU }
    await expect(failedCleanup()).rejects.toBe(cleanupError)
  })

  it('is skipped once the distro or WSL itself is confirmed gone', async () => {
    wslList = { code: 0, stdout: 'Debian\r\n' }
    await expect(failedCleanup()).resolves.toBeUndefined()

    wslList = enoent()
    await expect(failedCleanup()).resolves.toBeUndefined()

    wslList = { code: 4294967295, stdout: '' }
    registry = { code: 0, stdout: '' }
    await expect(failedCleanup()).resolves.toBeUndefined()
  })

  it('stands when the distros cannot be listed', async () => {
    wslList = { code: null, stdout: '' }
    registry = { code: 1, stdout: '' }
    await expect(failedCleanup()).rejects.toBe(cleanupError)

    wslList = new Error('EPERM')
    registry = new Error('EPERM')
    await expect(failedCleanup()).rejects.toBe(cleanupError)
  })
})
