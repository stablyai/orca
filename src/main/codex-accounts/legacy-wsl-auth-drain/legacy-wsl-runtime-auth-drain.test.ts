import { describe, expect, it, vi } from 'vitest'

const runWslProcess = vi.fn()
vi.mock('../../wsl/execution/wsl-runner', () => ({ runWslProcess }))

describe('startLegacyWslRuntimeAuthDrain', () => {
  it('lets a launch proceed when wsl.exe cannot run the inspect, and retries on the next launch', async () => {
    const { startLegacyWslRuntimeAuthDrain } = await import('./legacy-wsl-runtime-auth-drain')
    runWslProcess.mockResolvedValue({
      code: 4294967295,
      stdout: 'Catastrophic failure',
      stderr: '',
      timedOut: false,
      environmentResolved: true
    })
    const resolveDestination = vi.fn()
    const options = {
      distro: 'Ubuntu',
      guestHomeLinuxPath: '/home/user',
      legacyPanePresent: false,
      resolveDestination
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      startLegacyWslRuntimeAuthDrain(options, { throwOnFailure: true })
    ).resolves.toBeUndefined()
    await expect(
      startLegacyWslRuntimeAuthDrain(options, { throwOnFailure: true })
    ).resolves.toBeUndefined()

    expect(runWslProcess).toHaveBeenCalledTimes(2)
    expect(resolveDestination).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
