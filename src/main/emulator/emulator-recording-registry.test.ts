import { describe, expect, it, vi } from 'vitest'
import { EmulatorRecordingRegistry } from './emulator-recording-registry'

function fakeRecording(outputPath = '/tmp/demo.mp4', stop = vi.fn(async () => {})) {
  return { outputPath, stop }
}

describe('EmulatorRecordingRegistry', () => {
  it('rejects a second recording for the same device', () => {
    const registry = new EmulatorRecordingRegistry(() => 1_000)
    registry.register('UDID-1', fakeRecording())

    expect(() => registry.register('UDID-1', fakeRecording())).toThrowError(
      /already running for UDID-1/
    )
  })

  it('tracks recordings per device independently', () => {
    const registry = new EmulatorRecordingRegistry(() => 1_000)
    registry.register('UDID-1', fakeRecording('/tmp/one.mp4'))
    registry.register('UDID-2', fakeRecording('/tmp/two.mp4'))

    expect(registry.get('UDID-1')).toEqual({
      deviceId: 'UDID-1',
      outputPath: '/tmp/one.mp4',
      startedAt: 1_000
    })
    expect(registry.list()).toHaveLength(2)
  })

  it('rejects stopping a device that is not recording', async () => {
    const registry = new EmulatorRecordingRegistry()

    await expect(registry.stop('UDID-1')).rejects.toMatchObject({ code: 'emulator_no_active' })
  })

  it('frees the device even when stopping throws, so a retry can start again', async () => {
    const registry = new EmulatorRecordingRegistry()
    const stop = vi.fn(async () => {
      throw new Error('mux failed')
    })
    registry.register('UDID-1', fakeRecording('/tmp/demo.mp4', stop))

    await expect(registry.stop('UDID-1')).rejects.toThrow('mux failed')
    expect(registry.has('UDID-1')).toBe(false)
    expect(() => registry.register('UDID-1', fakeRecording())).not.toThrow()
  })

  it('stopIfRunning swallows failures and is a no-op when idle', async () => {
    const registry = new EmulatorRecordingRegistry()
    const stop = vi.fn(async () => {
      throw new Error('mux failed')
    })
    registry.register('UDID-1', fakeRecording('/tmp/demo.mp4', stop))

    await expect(registry.stopIfRunning('UDID-1')).resolves.toBeUndefined()
    await expect(registry.stopIfRunning('UDID-1')).resolves.toBeUndefined()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('stops every tracked recording on shutdown', async () => {
    const registry = new EmulatorRecordingRegistry()
    const first = vi.fn(async () => {})
    const second = vi.fn(async () => {})
    registry.register('UDID-1', fakeRecording('/tmp/one.mp4', first))
    registry.register('UDID-2', fakeRecording('/tmp/two.mp4', second))

    await registry.stopAll()

    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(registry.list()).toEqual([])
  })
})
