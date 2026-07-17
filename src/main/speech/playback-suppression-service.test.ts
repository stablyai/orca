import { describe, expect, it, vi } from 'vitest'
import {
  PlaybackSuppressionService,
  type PlaybackSuppressionAdapter,
  type PlaybackSuppressionSnapshot
} from './playback-suppression-service'

function createAdapter(initiallyMuted = false): PlaybackSuppressionAdapter {
  return {
    getCapability: vi.fn(async () => ({ available: true as const, backend: 'test' })),
    snapshot: vi.fn(async () => ({ backend: 'test', muted: initiallyMuted })),
    setMuted: vi.fn(async () => undefined)
  }
}

describe('PlaybackSuppressionService', () => {
  it('restores the exact unmuted state when the last owner releases', async () => {
    const adapter = createAdapter(false)
    const service = new PlaybackSuppressionService(adapter)

    await expect(service.acquire('dictation:1')).resolves.toEqual({ active: true })
    await service.release('dictation:1')

    expect(adapter.setMuted).toHaveBeenNthCalledWith(1, true, expect.any(AbortSignal))
    expect(adapter.setMuted).toHaveBeenNthCalledWith(2, false, expect.any(AbortSignal))
  })

  it('does not unmute output that was already muted', async () => {
    const adapter = createAdapter(true)
    const service = new PlaybackSuppressionService(adapter)

    await expect(service.acquire('dictation:1')).resolves.toEqual({ active: true })
    await service.release('dictation:1')

    expect(adapter.setMuted).not.toHaveBeenCalled()
  })

  it('keeps output muted until every owner releases', async () => {
    const adapter = createAdapter(false)
    const service = new PlaybackSuppressionService(adapter)

    await service.acquire('dictation:1')
    await service.acquire('dictation:2')
    await service.release('dictation:1')

    expect(adapter.setMuted).toHaveBeenCalledTimes(1)
    await service.release('dictation:2')
    expect(adapter.setMuted).toHaveBeenCalledTimes(2)
  })

  it('restores after the final owner releases while muting is still pending', async () => {
    let finishMute: (() => void) | undefined
    const snapshot: PlaybackSuppressionSnapshot = { backend: 'test', muted: false }
    const adapter: PlaybackSuppressionAdapter = {
      getCapability: vi.fn(async () => ({ available: true as const, backend: 'test' })),
      snapshot: vi.fn(async () => snapshot),
      setMuted: vi.fn((muted) =>
        muted
          ? new Promise<void>((resolve) => {
              finishMute = resolve
            })
          : Promise.resolve()
      )
    }
    const service = new PlaybackSuppressionService(adapter)

    const acquiring = service.acquire('dictation:1')
    await vi.waitFor(() => expect(finishMute).toBeTypeOf('function'))
    const releasing = service.release('dictation:1')
    finishMute?.()

    await expect(acquiring).resolves.toEqual({ active: false, reason: 'canceled' })
    await releasing
    expect(adapter.setMuted).toHaveBeenLastCalledWith(false, expect.any(AbortSignal))
  })

  it('fails open when the platform cannot be muted', async () => {
    const adapter = createAdapter(false)
    vi.mocked(adapter.setMuted).mockRejectedValueOnce(new Error('unavailable'))
    const service = new PlaybackSuppressionService(adapter)

    await expect(service.acquire('dictation:1')).resolves.toEqual({
      active: false,
      reason: 'unavailable'
    })
    expect(adapter.setMuted).toHaveBeenCalledTimes(1)
  })
})
