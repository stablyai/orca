import { describe, expect, it, vi } from 'vitest'
import {
  PlaybackSuppressionService,
  type PlaybackSuppressionAdapter,
  type PlaybackSuppressionRecoveryStore,
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

    const snapshot = { backend: 'test', muted: false }
    expect(adapter.setMuted).toHaveBeenNthCalledWith(1, true, expect.any(AbortSignal), snapshot)
    expect(adapter.setMuted).toHaveBeenNthCalledWith(2, false, expect.any(AbortSignal), snapshot)
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
    expect(adapter.setMuted).toHaveBeenLastCalledWith(false, expect.any(AbortSignal), snapshot)
  })

  it('waits for restoration before activating a new owner', async () => {
    let muted = false
    let finishRestore: (() => void) | undefined
    const adapter: PlaybackSuppressionAdapter = {
      getCapability: vi.fn(async () => ({ available: true as const, backend: 'test' })),
      snapshot: vi.fn(async () => ({ backend: 'test', muted })),
      setMuted: vi.fn(
        (nextMuted) =>
          new Promise<void>((resolve) => {
            if (!nextMuted) {
              finishRestore = () => {
                muted = false
                resolve()
              }
              return
            }
            muted = true
            resolve()
          })
      )
    }
    const service = new PlaybackSuppressionService(adapter)
    await service.acquire('dictation:1')

    const releasing = service.release('dictation:1')
    await vi.waitFor(() => expect(finishRestore).toBeTypeOf('function'))
    let acquisitionFinished = false
    const acquiring = service.acquire('dictation:2').then((result) => {
      acquisitionFinished = true
      return result
    })
    await Promise.resolve()

    expect(acquisitionFinished).toBe(false)
    finishRestore?.()
    await releasing
    await expect(acquiring).resolves.toEqual({ active: true })
    expect(muted).toBe(true)
  })

  it('retries restoration after a transient failure', async () => {
    let muted = false
    let failRestore = true
    const adapter: PlaybackSuppressionAdapter = {
      getCapability: vi.fn(async () => ({ available: true as const, backend: 'test' })),
      snapshot: vi.fn(async () => ({ backend: 'test', muted })),
      setMuted: vi.fn(async (nextMuted) => {
        if (!nextMuted && failRestore) {
          failRestore = false
          throw new Error('temporary restore failure')
        }
        muted = nextMuted
      })
    }
    const service = new PlaybackSuppressionService(adapter)

    await service.acquire('dictation:1')
    await expect(service.release('dictation:1')).rejects.toThrow('temporary restore failure')
    await service.acquire('dictation:2')
    await service.release('dictation:2')

    expect(muted).toBe(false)
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

  it('does not mute without an exact endpoint recovery target', async () => {
    const adapter = createAdapter(false)
    const recoveryStore: PlaybackSuppressionRecoveryStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }
    const service = new PlaybackSuppressionService(adapter, recoveryStore)

    await expect(service.acquire('dictation:1')).resolves.toEqual({
      active: false,
      reason: 'unavailable'
    })

    expect(adapter.setMuted).not.toHaveBeenCalled()
    expect(recoveryStore.write).not.toHaveBeenCalled()
  })

  it('records recovery state before muting and clears it after restoration', async () => {
    const calls: string[] = []
    const snapshot = {
      backend: 'test',
      endpointId: 'speaker-1',
      endpointTarget: '118',
      muted: false
    }
    const adapter: PlaybackSuppressionAdapter = {
      getCapability: vi.fn(async () => ({ available: true as const, backend: 'test' })),
      snapshot: vi.fn(async () => snapshot),
      setMuted: vi.fn(async (muted) => {
        calls.push(muted ? 'mute' : 'restore')
      })
    }
    const recoveryStore: PlaybackSuppressionRecoveryStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => {
        calls.push('write')
      }),
      clear: vi.fn(async () => {
        calls.push('clear')
      })
    }
    const service = new PlaybackSuppressionService(adapter, recoveryStore)

    await service.acquire('dictation:1')
    await service.release('dictation:1')

    expect(calls).toEqual(['write', 'mute', 'restore', 'clear'])
    expect(recoveryStore.write).toHaveBeenCalledWith(snapshot)
    expect(adapter.setMuted).toHaveBeenNthCalledWith(1, true, expect.any(AbortSignal), snapshot)
    expect(adapter.setMuted).toHaveBeenNthCalledWith(2, false, expect.any(AbortSignal), snapshot)
  })

  it('recovers a stranded mute only on the same endpoint', async () => {
    const marker = {
      backend: 'test',
      endpointId: 'speaker-1',
      endpointTarget: 'old-target',
      muted: false
    }
    const adapter = createAdapter(true)
    const current = {
      backend: 'test',
      endpointId: 'speaker-1',
      endpointTarget: 'current-target',
      muted: true
    }
    vi.mocked(adapter.snapshot).mockResolvedValue(current)
    const recoveryStore: PlaybackSuppressionRecoveryStore = {
      read: vi.fn(async () => marker),
      write: vi.fn(),
      clear: vi.fn(async () => undefined)
    }
    const service = new PlaybackSuppressionService(adapter, recoveryStore)

    await service.getCapability()

    expect(adapter.setMuted).toHaveBeenCalledWith(false, expect.any(AbortSignal), current)
    expect(recoveryStore.clear).toHaveBeenCalledTimes(1)
  })

  it('does not alter a different endpoint during crash recovery', async () => {
    const adapter = createAdapter(true)
    vi.mocked(adapter.snapshot).mockResolvedValue({
      backend: 'test',
      endpointId: 'speaker-2',
      muted: true
    })
    const recoveryStore: PlaybackSuppressionRecoveryStore = {
      read: vi.fn(async () => ({ backend: 'test', endpointId: 'speaker-1', muted: false })),
      write: vi.fn(),
      clear: vi.fn(async () => undefined)
    }
    const service = new PlaybackSuppressionService(adapter, recoveryStore)

    await service.getCapability()

    expect(adapter.setMuted).not.toHaveBeenCalled()
    expect(recoveryStore.clear).toHaveBeenCalledTimes(1)
  })

  it('clears recovery state when a failed mute left output unchanged', async () => {
    const adapter: PlaybackSuppressionAdapter = {
      getCapability: vi.fn(async () => ({ available: true as const, backend: 'test' })),
      snapshot: vi.fn(async () => ({
        backend: 'test',
        endpointId: 'speaker-1',
        endpointTarget: 'speaker-1',
        muted: false
      })),
      setMuted: vi.fn(async () => {
        throw new Error('mute failed')
      })
    }
    const recoveryStore: PlaybackSuppressionRecoveryStore = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    }
    const service = new PlaybackSuppressionService(adapter, recoveryStore)

    await expect(service.acquire('dictation:1')).resolves.toEqual({
      active: false,
      reason: 'unavailable'
    })

    expect(recoveryStore.clear).toHaveBeenCalledTimes(1)
  })
})
