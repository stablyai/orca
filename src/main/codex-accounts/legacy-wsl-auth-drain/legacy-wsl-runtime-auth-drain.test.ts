import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../../wsl/execution/wsl-runner', () => ({ runWslProcess: runWslProcessMock }))

import {
  drainLegacyWslRuntimeAuth,
  startLegacyWslRuntimeAuthDrain
} from './legacy-wsl-runtime-auth-drain'

const WSL_DIAGNOSTIC = '错误代码: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  runWslProcessMock.mockReset()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
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

describe('legacy WSL runtime auth drain when wsl.exe cannot run (#42641)', () => {
  it.each([4294967295, -1])(
    'keeps the launch unblocked when inspect exits %d, logging the stdout diagnostic',
    async (code) => {
      runWslProcessMock.mockResolvedValue(wslResult({ code, stdout: WSL_DIAGNOSTIC }))
      await expect(drainLegacyWslRuntimeAuth(drainOptions(`host-failed-${code}`))).resolves.toBe(
        'pending'
      )
      await expect(
        startLegacyWslRuntimeAuthDrain(drainOptions(`host-failed-start-${code}`), {
          throwOnFailure: true
        })
      ).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          `inspect step could not reach WSL, will retry: wsl.exe: ${WSL_DIAGNOSTIC}`
        )
      )
    }
  )

  it('treats an inspect timeout as pending', async () => {
    runWslProcessMock.mockResolvedValue(wslResult({ code: null, timedOut: true }))
    await expect(drainLegacyWslRuntimeAuth(drainOptions('timed-out'))).resolves.toBe('pending')
  })

  it('keeps finalize pending when wsl.exe cannot run it', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(wslResult({ code: 22 }))
      .mockResolvedValueOnce(wslResult({ code: 4294967295, stdout: WSL_DIAGNOSTIC }))
    await expect(
      drainLegacyWslRuntimeAuth({
        ...drainOptions('finalize-host-failed'),
        legacyPanePresent: false
      })
    ).resolves.toBe('pending')
  })

  it('keeps apply pending when neither apply nor re-inspection can reach WSL', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(wslResult({ code: 0, stdout: inspectPayload() }))
      .mockResolvedValue(wslResult({ code: 4294967295, stdout: WSL_DIAGNOSTIC }))
    await expect(drainLegacyWslRuntimeAuth(applyDrainOptions())).resolves.toBe('pending')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`apply step failed, re-inspecting: wsl.exe: ${WSL_DIAGNOSTIC}`)
    )
  })
})

describe('legacy WSL runtime auth drain guest-side failures', () => {
  it('still blocks the launch on a guest-side inspect defect', async () => {
    runWslProcessMock.mockResolvedValue(wslResult({ code: 46, stderr: 'marker not a file' }))
    await expect(drainLegacyWslRuntimeAuth(drainOptions('defect'))).rejects.toThrow(
      'Legacy WSL auth drain inspect failed (exit 46): marker not a file'
    )
    await expect(
      startLegacyWslRuntimeAuthDrain(drainOptions('defect-start'), { throwOnFailure: true })
    ).rejects.toThrow('Legacy WSL auth drain inspect failed (exit 46): marker not a file')
  })

  it('still blocks the launch when re-inspection after a failed apply hits a guest defect', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(wslResult({ code: 0, stdout: inspectPayload() }))
      .mockResolvedValueOnce(wslResult({ code: 44, stderr: 'apply broke' }))
      .mockResolvedValueOnce(wslResult({ code: 46, stderr: 'marker not a file' }))
    await expect(drainLegacyWslRuntimeAuth(applyDrainOptions())).rejects.toThrow(
      'Legacy WSL auth drain recover failed (exit 46): marker not a file'
    )
  })

  it('logs a guest-side apply failure and retries when re-inspection shows nothing moved', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(wslResult({ code: 0, stdout: inspectPayload() }))
      .mockResolvedValueOnce(wslResult({ code: 43, stderr: 'credentials changed' }))
      .mockResolvedValueOnce(wslResult({ code: 0, stdout: inspectPayload() }))
    await expect(drainLegacyWslRuntimeAuth(applyDrainOptions())).resolves.toBe('pending')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('apply step failed, re-inspecting: credentials changed')
    )
  })

  it('reports complete when re-inspection finds the marker after an apply failure', async () => {
    runWslProcessMock
      .mockResolvedValueOnce(wslResult({ code: 0, stdout: inspectPayload() }))
      .mockResolvedValueOnce(wslResult({ code: 44 }))
      .mockResolvedValueOnce(wslResult({ code: 20 }))
    await expect(drainLegacyWslRuntimeAuth(applyDrainOptions())).resolves.toBe('complete')
  })
})
