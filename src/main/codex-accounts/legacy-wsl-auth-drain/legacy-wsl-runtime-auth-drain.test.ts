import { afterEach, describe, expect, it, vi } from 'vitest'
import { startLegacyWslRuntimeAuthDrain } from './legacy-wsl-runtime-auth-drain'

const runWslProcess = vi.hoisted(() => vi.fn())
vi.mock('../../wsl/execution/wsl-runner', () => ({ runWslProcess }))

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

  it('lets a launch proceed when wsl.exe failed before the inspect ran, and retries on the next launch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    runWslProcess.mockResolvedValue(
      inspectResult({
        code: 4294967295,
        stdout: 'Catastrophic failure\r\nError code: Wsl/Service/E_UNEXPECTED\r\n'
      })
    )
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

  it('still blocks a launch when the inspect timed out, since its recovery may have been cut off', async () => {
    runWslProcess.mockResolvedValue(inspectResult({ code: null, stdout: '', timedOut: true }))

    await expect(
      startLegacyWslRuntimeAuthDrain(drainOptions('Debian'), { throwOnFailure: true })
    ).rejects.toThrow('Legacy WSL auth drain inspect failed (timeout)')
  })

  it('blocks a launch and keeps the auth files out of the error when the inspect printed them', async () => {
    const authBase64 = 'eyJ0b2tlbnMiOnsicmVmcmVzaF90b2tlbiI6InNlY3JldCJ9fQ=='
    runWslProcess.mockResolvedValue(
      inspectResult({ code: 4294967295, stdout: `${authBase64}\npresent\n${authBase64}\n` })
    )

    const drained = startLegacyWslRuntimeAuthDrain(drainOptions('Fedora'), {
      throwOnFailure: true
    })

    await expect(drained).rejects.toThrow('Legacy WSL auth drain inspect failed (exit 4294967295)')
    await expect(drained).rejects.not.toThrow(authBase64)
  })

  it('blocks a launch when wsl.exe appended its error to auth the guest was printing', async () => {
    const authBase64 = 'eyJ0b2tlbnMiOnsicmVmcmVzaF90b2tlbiI6InNlY3JldCJ9fQ=='
    runWslProcess.mockResolvedValue(
      inspectResult({
        code: 4294967295,
        stdout: `${authBase64}Catastrophic failure\r\nError code: Wsl/Service/E_UNEXPECTED\r\n`
      })
    )

    const drained = startLegacyWslRuntimeAuthDrain(drainOptions('Arch'), { throwOnFailure: true })

    await expect(drained).rejects.toThrow('Legacy WSL auth drain inspect failed (exit 4294967295)')
    await expect(drained).rejects.not.toThrow(authBase64.slice(0, 8))
  })
})
