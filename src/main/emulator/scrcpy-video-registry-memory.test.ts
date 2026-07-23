import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SCRCPY_VIDEO_MAX_GOP_FRAMES,
  SCRCPY_VIDEO_MAX_REGISTRY_ENTRIES,
  SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE,
  SCRCPY_VIDEO_MAX_REPLAY_BYTES_TOTAL,
  SCRCPY_VIDEO_MAX_SUBSCRIBERS,
  scrcpyVideoRegistry,
  type ScrcpyVideoFrameMessage
} from './scrcpy-video-registry'

const MEBIBYTE = 1024 * 1024
const registeredDevices = new Set<string>()

function registerDevice(deviceId: string, close = vi.fn()): void {
  scrcpyVideoRegistry.register(deviceId, close)
  registeredDevices.add(deviceId)
}

function frame(
  pts: string,
  byteLength: number,
  options: { config?: boolean; keyFrame?: boolean } = {}
): ScrcpyVideoFrameMessage {
  return {
    config: options.config === true,
    keyFrame: options.keyFrame === true,
    pts,
    bytes: { byteLength } as ArrayBuffer
  }
}

function replayFrames(deviceId: string): ScrcpyVideoFrameMessage[] {
  const frames: ScrcpyVideoFrameMessage[] = []
  const unsubscribe = scrcpyVideoRegistry.subscribe(deviceId, (event) => {
    if (event.type === 'frame') {
      frames.push(event.frame)
    }
  })
  unsubscribe()
  return frames
}

function replayBytes(deviceId: string): number {
  return replayFrames(deviceId).reduce((total, replayed) => total + replayed.bytes.byteLength, 0)
}

afterEach(() => {
  for (const deviceId of registeredDevices) {
    scrcpyVideoRegistry.stop(deviceId)
  }
  registeredDevices.clear()
})

describe('scrcpy video replay retention', () => {
  it('sheds an overloaded GOP until a fresh keyframe arrives', () => {
    registerDevice('frame-cap')
    scrcpyVideoRegistry.pushFrame('frame-cap', frame('key', 1, { keyFrame: true }))
    for (let index = 1; index <= SCRCPY_VIDEO_MAX_GOP_FRAMES + 10; index += 1) {
      scrcpyVideoRegistry.pushFrame('frame-cap', frame(String(index), 1))
    }

    expect(replayFrames('frame-cap')).toEqual([])

    scrcpyVideoRegistry.pushFrame('frame-cap', frame('recovery-key', 1, { keyFrame: true }))
    expect(replayFrames('frame-cap').map((replayed) => replayed.pts)).toEqual(['recovery-key'])
  })

  it('sheds only cached deltas under per-device byte pressure', () => {
    registerDevice('device-bytes')
    const liveFrames: string[] = []
    const unsubscribe = scrcpyVideoRegistry.subscribe('device-bytes', (event) => {
      if (event.type === 'frame') {
        liveFrames.push(event.frame.pts)
      }
    })

    scrcpyVideoRegistry.pushFrame('device-bytes', frame('config', MEBIBYTE, { config: true }))
    scrcpyVideoRegistry.pushFrame('device-bytes', frame('key', 8 * MEBIBYTE, { keyFrame: true }))
    for (let index = 1; index <= 5; index += 1) {
      scrcpyVideoRegistry.pushFrame('device-bytes', frame(`delta-${index}`, 8 * MEBIBYTE))
    }
    unsubscribe()

    expect(liveFrames).toEqual([
      'config',
      'key',
      'delta-1',
      'delta-2',
      'delta-3',
      'delta-4',
      'delta-5'
    ])
    expect(replayFrames('device-bytes').map((replayed) => replayed.pts)).toEqual(['config'])
    expect(replayBytes('device-bytes')).toBeLessThanOrEqual(
      SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE
    )
    scrcpyVideoRegistry.pushFrame(
      'device-bytes',
      frame('recovery-key', 8 * MEBIBYTE, { keyFrame: true })
    )
    expect(replayFrames('device-bytes').map((replayed) => replayed.pts)).toEqual([
      'config',
      'recovery-key'
    ])
  })

  it('delivers an oversized frame live without retaining invalid replay', () => {
    registerDevice('oversized')
    const liveFrames: string[] = []
    const unsubscribe = scrcpyVideoRegistry.subscribe('oversized', (event) => {
      if (event.type === 'frame') {
        liveFrames.push(event.frame.pts)
      }
    })
    scrcpyVideoRegistry.pushFrame('oversized', frame('config', 1, { config: true }))
    scrcpyVideoRegistry.pushFrame(
      'oversized',
      frame('key', SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE, { keyFrame: true })
    )
    unsubscribe()

    expect(liveFrames).toEqual(['config', 'key'])
    expect(replayFrames('oversized').map((replayed) => replayed.pts)).toEqual(['config'])
  })

  it('bounds replay bytes across devices while protecting the newest device', () => {
    const perEntryBytes = 16 * MEBIBYTE
    const deviceCount = Math.floor(SCRCPY_VIDEO_MAX_REPLAY_BYTES_TOTAL / perEntryBytes) + 1
    const deviceIds = Array.from({ length: deviceCount }, (_, index) => `aggregate-${index}`)

    for (const deviceId of deviceIds) {
      registerDevice(deviceId)
      scrcpyVideoRegistry.pushFrame(deviceId, frame('config', MEBIBYTE, { config: true }))
      scrcpyVideoRegistry.pushFrame(
        deviceId,
        frame('key', perEntryBytes - MEBIBYTE, { keyFrame: true })
      )
    }

    const totalReplayBytes = deviceIds.reduce((total, deviceId) => total + replayBytes(deviceId), 0)
    expect(totalReplayBytes).toBeLessThanOrEqual(SCRCPY_VIDEO_MAX_REPLAY_BYTES_TOTAL)
    expect(replayFrames(deviceIds.at(-1)!).map((replayed) => replayed.pts)).toEqual([
      'config',
      'key'
    ])
    for (const deviceId of deviceIds) {
      expect(replayFrames(deviceId).map((replayed) => replayed.pts)).toEqual(
        expect.arrayContaining(['config'])
      )
    }
  })

  it('cleans accounting before a reentrant close callback', () => {
    const close = vi.fn(() => scrcpyVideoRegistry.stop('reentrant'))
    registerDevice('reentrant', close)
    scrcpyVideoRegistry.pushFrame(
      'reentrant',
      frame('key', SCRCPY_VIDEO_MAX_REPLAY_BYTES_PER_DEVICE, { keyFrame: true })
    )

    scrcpyVideoRegistry.stop('reentrant')

    expect(close).toHaveBeenCalledOnce()
    expect(scrcpyVideoRegistry.has('reentrant')).toBe(false)
  })

  it('bounds active registry entries without closing admitted streams', () => {
    const closes: ReturnType<typeof vi.fn>[] = []
    for (let index = 0; index < SCRCPY_VIDEO_MAX_REGISTRY_ENTRIES; index += 1) {
      const close = vi.fn()
      closes.push(close)
      registerDevice(`entry-${index}`, close)
    }

    expect(() => registerDevice('entry-overflow')).toThrow(/active scrcpy video streams/)
    for (const close of closes) {
      expect(close).not.toHaveBeenCalled()
    }
  })

  it('bounds subscriber callbacks and releases admission on unsubscribe', () => {
    registerDevice('subscriber-cap')
    const unsubscribes = Array.from({ length: SCRCPY_VIDEO_MAX_SUBSCRIBERS }, () =>
      scrcpyVideoRegistry.subscribe('subscriber-cap', () => {})
    )

    expect(() => scrcpyVideoRegistry.subscribe('subscriber-cap', () => {})).toThrow(
      /video subscribers/
    )
    unsubscribes[0]()
    expect(() => scrcpyVideoRegistry.subscribe('subscriber-cap', () => {})).not.toThrow()
  })
})
