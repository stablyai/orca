import { describe, expect, it, vi } from 'vitest'
import { EmulatorSessionRegistry } from './emulator-session-registry'

describe('workspace emulator generation', () => {
  it('preserves Android stream identity on reuse and replaces it on restart', () => {
    const registry = new EmulatorSessionRegistry()
    const info = {
      deviceUdid: 'emulator-5554',
      streamUrl: 'scrcpy://emulator-5554',
      wsUrl: '',
      backend: 'android' as const,
      instanceId: 'first'
    }
    registry.registerActive('a', info, { managed: true })
    const first = registry.generationForDevice(info.deviceUdid)
    registry.registerActive('b', info, { managed: true })
    expect(registry.generationForDevice(info.deviceUdid)).toBe(first)
    expect(
      registry.registerActive('a', { ...info, instanceId: 'second' }, { managed: true })
    ).toEqual(['a', 'b'])
    expect(registry.isCurrentOwner('b', info.deviceUdid, first)).toBe(false)
    expect(registry.getActiveForWorktree('b')?.instanceId).toBe('second')
  })

  it('does not equate unknown Android identities but retains unchanged iOS identity', () => {
    const registry = new EmulatorSessionRegistry()
    const legacy = {
      deviceUdid: 'emulator-5554',
      streamUrl: 'scrcpy://emulator-5554',
      wsUrl: '',
      backend: 'android' as const
    }
    registry.registerActive('a', legacy)
    const first = registry.generationForDevice(legacy.deviceUdid)
    registry.registerActive('b', legacy)
    expect(registry.generationForDevice(legacy.deviceUdid)).not.toBe(first)
    const ios = {
      deviceUdid: 'ios-1',
      streamUrl: 'http://127.0.0.1:1000/stream',
      wsUrl: 'ws://127.0.0.1:1000/ws',
      helperPid: 12,
      backend: 'ios' as const
    }
    registry.registerActive('a', ios)
    const iosGeneration = registry.generationForDevice(ios.deviceUdid)
    registry.registerActive('b', ios)
    expect(registry.generationForDevice(ios.deviceUdid)).toBe(iosGeneration)
  })

  it('evicts using the captured Android generation rather than a replacement', async () => {
    const registry = new EmulatorSessionRegistry()
    const info = {
      deviceUdid: 'emulator-5554',
      streamUrl: 'scrcpy://emulator-5554',
      wsUrl: '',
      backend: 'android' as const,
      instanceId: 'old'
    }
    registry.registerActive('a', info, { managed: true })
    let finish!: (ids: string[]) => void
    const stop = vi.fn(async () => {})
    const backend = {
      listRunningDeviceIds: () =>
        new Promise<string[]>((resolve) => {
          finish = resolve
        }),
      stopHelperForDevice: stop
    }
    const census = registry.pruneGoneManagedSessions(() => backend)
    finish([])
    await census
    expect(stop).toHaveBeenCalledWith(
      'emulator-5554',
      expect.objectContaining({ instanceId: 'old', requireInstanceId: true })
    )
  })
})
