import { describe, expect, it, vi } from 'vitest'
import {
  PlaybackSuppressionService,
  type PlaybackSuppressionAdapter,
  type PlaybackSuppressionRecoveryStore,
  type PlaybackSuppressionSnapshot
} from './playback-suppression-service'

const snapshot: PlaybackSuppressionSnapshot = { backend: 'test', muted: false }

describe('PlaybackSuppressionService ownership races', () => {
  it('restarts activation for an owner that arrives after a stale snapshot', async () => {
    let finishFirstSnapshot: ((value: PlaybackSuppressionSnapshot) => void) | undefined
    const firstSnapshot = new Promise<PlaybackSuppressionSnapshot>((resolve) => {
      finishFirstSnapshot = resolve
    })
    const adapter: PlaybackSuppressionAdapter = {
      getCapability: vi.fn(async () => true),
      snapshot: vi
        .fn()
        .mockImplementationOnce(() => firstSnapshot)
        .mockResolvedValue(snapshot),
      setMuted: vi.fn(async () => undefined)
    }
    const service = new PlaybackSuppressionService(adapter)

    const firstAcquisition = service.acquire('dictation:1')
    await vi.waitFor(() => expect(adapter.snapshot).toHaveBeenCalledOnce())
    const firstRelease = service.release('dictation:1')
    const secondAcquisition = service.acquire('dictation:2')
    finishFirstSnapshot?.(snapshot)

    await expect(firstAcquisition).resolves.toEqual({ active: false, reason: 'canceled' })
    await firstRelease
    await expect(secondAcquisition).resolves.toEqual({ active: true })
    await service.release('dictation:2')

    expect(adapter.setMuted).toHaveBeenNthCalledWith(1, true, expect.any(AbortSignal), snapshot)
    expect(adapter.setMuted).toHaveBeenNthCalledWith(2, false, expect.any(AbortSignal), snapshot)
  })

  it('preserves a new owner when a stale activation throws', async () => {
    let failFirstMute: ((error: Error) => void) | undefined
    const firstMute = new Promise<void>((_resolve, reject) => {
      failFirstMute = reject
    })
    const adapter: PlaybackSuppressionAdapter = {
      getCapability: vi.fn(async () => true),
      snapshot: vi.fn(async () => snapshot),
      setMuted: vi
        .fn()
        .mockImplementationOnce(() => firstMute)
        .mockResolvedValue(undefined)
    }
    const service = new PlaybackSuppressionService(adapter)

    const firstAcquisition = service.acquire('dictation:1')
    await vi.waitFor(() => expect(adapter.setMuted).toHaveBeenCalledOnce())
    const firstRelease = service.release('dictation:1')
    const secondAcquisition = service.acquire('dictation:2')
    failFirstMute?.(new Error('stale mute failed'))

    await expect(firstAcquisition).resolves.toEqual({ active: false, reason: 'canceled' })
    await firstRelease
    await expect(secondAcquisition).resolves.toEqual({ active: true })
    await service.release('dictation:2')

    expect(adapter.setMuted).toHaveBeenCalledTimes(3)
  })
})

describe('PlaybackSuppressionService durable restoration races', () => {
  it('reconciles the recovery marker before activating a new owner', async () => {
    let muted = false
    let restoreFailures = 2
    let storedMarker: PlaybackSuppressionSnapshot | null = null
    const endpoint = {
      backend: 'test',
      endpointId: 'speaker-1',
      endpointTarget: 'speaker-1',
      muted: false
    }
    const adapter: PlaybackSuppressionAdapter = {
      getCapability: vi.fn(async () => true),
      snapshot: vi.fn(async () => ({ ...endpoint, muted })),
      setMuted: vi.fn(async (nextMuted) => {
        if (!nextMuted && restoreFailures > 0) {
          restoreFailures -= 1
          throw new Error('persistent restore failure')
        }
        muted = nextMuted
      })
    }
    const recoveryStore: PlaybackSuppressionRecoveryStore = {
      read: vi.fn(async () => storedMarker),
      write: vi.fn(async (value) => {
        storedMarker = value
      }),
      clear: vi.fn(async () => {
        storedMarker = null
      })
    }
    const service = new PlaybackSuppressionService(adapter, recoveryStore)

    await expect(service.acquire('dictation:1')).resolves.toEqual({ active: true })
    await expect(service.release('dictation:1')).rejects.toThrow('persistent restore failure')
    await expect(service.acquire('dictation:2')).resolves.toEqual({ active: true })

    expect(recoveryStore.read).toHaveBeenCalledTimes(2)
    expect(recoveryStore.write).toHaveBeenCalledTimes(2)
    expect(recoveryStore.clear).toHaveBeenCalledOnce()
    expect(adapter.setMuted).toHaveBeenNthCalledWith(
      4,
      false,
      expect.any(AbortSignal),
      expect.objectContaining({ endpointId: 'speaker-1', muted: true })
    )
    expect(adapter.setMuted).toHaveBeenNthCalledWith(
      5,
      true,
      expect.any(AbortSignal),
      expect.objectContaining({ endpointId: 'speaker-1', muted: false })
    )
    expect(muted).toBe(true)

    await service.release('dictation:2')
    expect(muted).toBe(false)
  })
})
