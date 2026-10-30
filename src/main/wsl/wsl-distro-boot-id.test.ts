import { beforeEach, describe, expect, it, vi } from 'vitest'

const runProcess = vi.hoisted(() => vi.fn())
vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('./wsl-executable-path', () => ({ resolveWslExecutablePath: () => 'wsl.exe' }))
vi.mock('../wsl-interop-spawn-directory', () => ({ resolveWslInteropSpawnCwd: () => 'C:\\' }))

import { readWslDistroBootId } from './wsl-distro-boot-id'

const BOOT_ID = '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f'
const answer = (result: Partial<{ code: number; stdout: string; timedOut: boolean }>) =>
  runProcess.mockResolvedValueOnce({ code: 0, stdout: '', timedOut: false, ...result })

beforeEach(() => runProcess.mockReset())

describe('readWslDistroBootId', () => {
  it('reads the boot id with --exec and no shell, so no rc file runs', async () => {
    answer({ stdout: `${BOOT_ID.toUpperCase()}\n` })
    await expect(readWslDistroBootId('Ubuntu')).resolves.toBe(BOOT_ID)
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'wsl.exe',
        args: ['-d', 'Ubuntu', '--exec', 'cat', '/proc/sys/kernel/random/boot_id']
      })
    )
  })

  it.each([
    ['a failed read', { code: 1, stdout: BOOT_ID }],
    ['a timeout', { timedOut: true, stdout: BOOT_ID }],
    ['output that is not a boot id', { stdout: `Welcome to Ubuntu\n${BOOT_ID}` }]
  ])('answers null for %s', async (_name, result) => {
    answer(result)
    await expect(readWslDistroBootId('Ubuntu')).resolves.toBeNull()
  })
})
