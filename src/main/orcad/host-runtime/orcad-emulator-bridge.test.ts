import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BackendServiceCleanup } from '../../backend/service-composition'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

const { destroy } = vi.hoisted(() => ({ destroy: vi.fn() }))
vi.mock('../../emulator/emulator-bridge', () => ({
  EmulatorBridge: class {
    destroyAllSessions = destroy
  }
}))
import { installOrcadEmulatorBridge } from './orcad-emulator-bridge'

describe('orcad emulator cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
    destroy.mockReset()
  })

  function cleanup(): BackendServiceCleanup {
    let action!: BackendServiceCleanup
    installOrcadEmulatorBridge(
      { setEmulatorBridge: vi.fn() } as unknown as OrcaRuntimeService,
      (value) => {
        action = value
      }
    )
    return action
  }

  it('preserves a shutdown failure', async () => {
    destroy.mockRejectedValueOnce(new Error('ownership retained'))
    await expect(cleanup()({ failed: false })).rejects.toThrow('ownership retained')
  })

  it('aborts before reporting a timeout', async () => {
    vi.useFakeTimers()
    destroy.mockReturnValueOnce(new Promise(() => {}))
    const result = Promise.resolve(cleanup()({ failed: false })).then(
      () => 'ok',
      (error: Error) => error.message
    )
    const signal = destroy.mock.calls[0][0].signal as AbortSignal
    await vi.advanceTimersByTimeAsync(3000)
    expect(signal.aborted).toBe(true)
    expect(await result).toContain('timed out')
  })
})
