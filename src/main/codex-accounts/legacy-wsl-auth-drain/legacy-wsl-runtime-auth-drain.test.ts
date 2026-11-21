import { afterEach, describe, expect, it, vi } from 'vitest'
import { startLegacyWslRuntimeAuthDrain } from './legacy-wsl-runtime-auth-drain'

const runWslProcess = vi.hoisted(() => vi.fn())
vi.mock('../../wsl/execution/wsl-runner', () => ({ runWslProcess }))

const WSL_EXE_FAILURE = 'Catastrophic failure\r\nError code: Wsl/Service/E_UNEXPECTED\r\n'
const AUTH_BASE64 = 'eyJ0b2tlbnMiOnsicmVmcmVzaF90b2tlbiI6InNlY3JldCJ9fQ=='

function drainOptions(distro: string) {
  return {
    distro,
    guestHomeLinuxPath: '/home/user',
    legacyPanePresent: false,
    resolveDestination: vi.fn()
  }
}

function inspectResult(result: { code: number | null; stdout: string; timedOut?: boolean }) {
  return { stderr: '', timedOut: false, environmentResolved: true, ...result }
}

describe('startLegacyWslRuntimeAuthDrain', () => {
  afterEach(() => {
    runWslProcess.mockReset()
    vi.restoreAllMocks()
  })

  it('lets a launch proceed when wsl.exe failed before the inspect started, and retries on the next launch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    runWslProcess.mockResolvedValue(inspectResult({ code: 4294967295, stdout: WSL_EXE_FAILURE }))
    const options = drainOptions('Ubuntu')

    await expect(
      startLegacyWslRuntimeAuthDrain(options, { throwOnFailure: true })
    ).resolves.toBeUndefined()
    await expect(
      startLegacyWslRuntimeAuthDrain(options, { throwOnFailure: true })
    ).resolves.toBeUndefined()

    expect(runWslProcess).toHaveBeenCalledTimes(2)
    expect(options.resolveDestination).not.toHaveBeenCalled()
  })

  it('blocks a launch when wsl.exe failed after the inspect started its silent recovery', async () => {
    runWslProcess.mockResolvedValue(
      inspectResult({ code: 4294967295, stdout: `ORCA_DRAIN_INSPECT_STARTED\n${WSL_EXE_FAILURE}` })
    )

    await expect(
      startLegacyWslRuntimeAuthDrain(drainOptions('Alpine'), { throwOnFailure: true })
    ).rejects.toThrow('Legacy WSL auth drain inspect failed (exit 4294967295)')
  })

  it('blocks a launch and keeps auth out of the error when wsl.exe failed mid-print', async () => {
    runWslProcess.mockResolvedValue(
      inspectResult({
        code: 4294967295,
        stdout: `ORCA_DRAIN_INSPECT_STARTED\n${AUTH_BASE64}${WSL_EXE_FAILURE}`
      })
    )

    const drained = startLegacyWslRuntimeAuthDrain(drainOptions('Arch'), { throwOnFailure: true })

    await expect(drained).rejects.toThrow('Legacy WSL auth drain inspect failed (exit 4294967295)')
    await expect(drained).rejects.not.toThrow(AUTH_BASE64.slice(0, 8))
  })

  it('still blocks a launch when the inspect timed out', async () => {
    runWslProcess.mockResolvedValue(inspectResult({ code: null, stdout: '', timedOut: true }))

    await expect(
      startLegacyWslRuntimeAuthDrain(drainOptions('Debian'), { throwOnFailure: true })
    ).rejects.toThrow('Legacy WSL auth drain inspect failed (timeout)')
  })
})
