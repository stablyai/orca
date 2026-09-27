import { describe, expect, it, vi } from 'vitest'
import { tearDownRuntime, type InstalledRuntime } from './structured-agent-session-runtime-teardown'

function installed(waitForRecovery: () => Promise<void>) {
  const savedStatus = { close: vi.fn() }
  const runtime = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown reads only `flushAllStreamedEvents` from the host.
    host: {
      flushAllStreamedEvents: vi.fn(async () => undefined)
    } as unknown as InstalledRuntime['host'],
    adapter: { closeAll: vi.fn(async () => undefined) },
    savedStatus,
    waitForRecovery
  }
  return { runtime, savedStatus }
}

describe('structured runtime teardown', () => {
  it('closes the saved-status store last', async () => {
    const { runtime, savedStatus } = installed(async () => undefined)
    await tearDownRuntime(runtime, 'quit')
    expect(savedStatus.close).toHaveBeenCalledTimes(1)
    expect(savedStatus.close.mock.invocationCallOrder[0]).toBeGreaterThan(
      runtime.adapter.closeAll.mock.invocationCallOrder[0]!
    )
  })

  it('still closes the saved-status store when the first recovery drain fails', async () => {
    const { runtime, savedStatus } = installed(async () => {
      throw new Error('recovery failed')
    })
    await expect(tearDownRuntime(runtime, 'quit')).rejects.toThrow('recovery failed')
    expect(savedStatus.close).toHaveBeenCalledTimes(1)
  })
})
