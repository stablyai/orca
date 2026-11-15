import { describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../../wsl/execution/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import {
  drainLegacyWslRuntimeAuth,
  startLegacyWslRuntimeAuthDrain
} from './legacy-wsl-runtime-auth-drain'

function drainOptions(distro: string) {
  return {
    distro,
    guestHomeLinuxPath: '/home/user',
    legacyPanePresent: true,
    resolveDestination: async () => null
  }
}

function wslResult(
  overrides: Partial<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>
) {
  return {
    environmentResolved: true,
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  }
}

describe('legacy WSL runtime auth drain environment failures (#42641)', () => {
  it('treats a wsl.exe host-failure inspect (exit 4294967295, diagnostic on stdout) as pending', async () => {
    runWslProcessMock.mockResolvedValue(
      wslResult({
        code: 4294967295,
        stdout: '错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'
      })
    )
    await expect(drainLegacyWslRuntimeAuth(drainOptions('host-failed'))).resolves.toBe('pending')
    await expect(
      startLegacyWslRuntimeAuthDrain(drainOptions('host-failed-start'), { throwOnFailure: true })
    ).resolves.toBeUndefined()
  })

  it('treats an inspect timeout as pending', async () => {
    runWslProcessMock.mockResolvedValue(wslResult({ code: null, timedOut: true }))
    await expect(drainLegacyWslRuntimeAuth(drainOptions('timed-out'))).resolves.toBe('pending')
  })

  it('still throws for guest-side inspect defects', async () => {
    runWslProcessMock.mockResolvedValue(wslResult({ code: 46, stderr: 'marker not a file' }))
    await expect(drainLegacyWslRuntimeAuth(drainOptions('defect'))).rejects.toThrow(
      'Legacy WSL auth drain inspect failed (exit 46): marker not a file'
    )
  })
})
