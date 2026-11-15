import { beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../../wsl/execution/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import {
  drainLegacyWslRuntimeAuth,
  startLegacyWslRuntimeAuthDrain
} from './legacy-wsl-runtime-auth-drain'

beforeEach(() => {
  runWslProcessMock.mockReset()
})

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

function inspectPayload(): string {
  return `${Buffer.from('auth-contents').toString('base64')}\nmissing`
}

function applyDrainOptions() {
  return {
    ...drainOptions('apply-distro'),
    resolveDestination: async () => ({
      authContents: 'destination-auth',
      linuxHomePath: '/home/other'
    })
  }
}

describe('legacy WSL runtime auth drain apply failures (#42641)', () => {
  it('logs the wsl.exe diagnostic and stays pending when apply cannot reach WSL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      runWslProcessMock
        .mockResolvedValueOnce(wslResult({ code: 0, stdout: inspectPayload() }))
        .mockResolvedValueOnce(
          wslResult({ code: 4294967295, stdout: '错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND' })
        )
        .mockResolvedValueOnce(wslResult({ code: 0, stdout: inspectPayload() }))
      await expect(drainLegacyWslRuntimeAuth(applyDrainOptions())).resolves.toBe('pending')
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'apply step could not reach WSL, will retry: wsl.exe: 错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'
        )
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('throws for a guest-side apply defect when re-inspection shows nothing moved', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(wslResult({ code: 0, stdout: inspectPayload() }))
      .mockResolvedValueOnce(wslResult({ code: 46, stderr: 'session links not a file' }))
      .mockResolvedValueOnce(wslResult({ code: 0, stdout: inspectPayload() }))
    await expect(drainLegacyWslRuntimeAuth(applyDrainOptions())).rejects.toThrow(
      'Legacy WSL auth drain apply failed (exit 46): session links not a file'
    )
  })

  it('keeps hash-drift apply exits (37/38) on the retry path', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(wslResult({ code: 0, stdout: inspectPayload() }))
      .mockResolvedValueOnce(wslResult({ code: 37 }))
      .mockResolvedValueOnce(wslResult({ code: 0, stdout: inspectPayload() }))
    await expect(drainLegacyWslRuntimeAuth(applyDrainOptions())).resolves.toBe('pending')
  })

  it('reports complete when re-inspection finds the marker after an apply failure', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(wslResult({ code: 0, stdout: inspectPayload() }))
      .mockResolvedValueOnce(wslResult({ code: 44 }))
      .mockResolvedValueOnce(wslResult({ code: 20 }))
    await expect(drainLegacyWslRuntimeAuth(applyDrainOptions())).resolves.toBe('complete')
  })
})
