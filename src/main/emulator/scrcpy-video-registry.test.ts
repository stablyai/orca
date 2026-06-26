import { describe, expect, it, vi } from 'vitest'
import { scrcpyVideoRegistry, type ScrcpyVideoEvent } from './scrcpy-video-registry'

function frame(config: boolean): {
  config: boolean
  keyFrame: boolean
  pts: string
  bytes: ArrayBuffer
} {
  return { config, keyFrame: !config, pts: '0', bytes: new ArrayBuffer(2) }
}

describe('scrcpyVideoRegistry', () => {
  it('replays cached meta + config to late subscribers and stops cleanly', () => {
    const close = vi.fn()
    scrcpyVideoRegistry.register('dev', close)
    scrcpyVideoRegistry.pushMeta('dev', { codecId: 'h264', width: 1, height: 2 })
    scrcpyVideoRegistry.pushFrame('dev', frame(true))

    const events: ScrcpyVideoEvent['type'][] = []
    const unsubscribe = scrcpyVideoRegistry.subscribe('dev', (event) => events.push(event.type))
    expect(events).toEqual(['meta', 'frame']) // replayed cached meta + config

    scrcpyVideoRegistry.pushFrame('dev', frame(false))
    expect(events).toEqual(['meta', 'frame', 'frame'])

    unsubscribe()
    scrcpyVideoRegistry.pushFrame('dev', frame(false))
    expect(events).toEqual(['meta', 'frame', 'frame']) // no delivery after unsubscribe

    scrcpyVideoRegistry.stop('dev')
    expect(close).toHaveBeenCalledTimes(1)
    expect(scrcpyVideoRegistry.has('dev')).toBe(false)
  })

  it('ignores pushes for unknown devices', () => {
    expect(() =>
      scrcpyVideoRegistry.pushMeta('missing', { codecId: 'h264', width: 1, height: 1 })
    ).not.toThrow()
    expect(scrcpyVideoRegistry.subscribe('missing', () => {})()).toBeUndefined()
  })

  it('replays the current GOP (keyframe + following deltas) to late subscribers', () => {
    scrcpyVideoRegistry.register('gop', () => {})
    const tag = (event: ScrcpyVideoEvent): string =>
      event.type === 'frame' ? `${event.frame.keyFrame ? 'K' : 'D'}${event.frame.pts}` : 'M'
    scrcpyVideoRegistry.pushFrame('gop', {
      config: false,
      keyFrame: true,
      pts: '1',
      bytes: new ArrayBuffer(2)
    })
    scrcpyVideoRegistry.pushFrame('gop', {
      config: false,
      keyFrame: false,
      pts: '2',
      bytes: new ArrayBuffer(2)
    })

    const seen: string[] = []
    scrcpyVideoRegistry.subscribe('gop', (event) => seen.push(tag(event)))()
    expect(seen).toEqual(['K1', 'D2'])

    // A new keyframe drops the prior GOP so replay always starts decodeable.
    scrcpyVideoRegistry.pushFrame('gop', {
      config: false,
      keyFrame: true,
      pts: '3',
      bytes: new ArrayBuffer(2)
    })
    const seen2: string[] = []
    scrcpyVideoRegistry.subscribe('gop', (event) => seen2.push(tag(event)))()
    expect(seen2).toEqual(['K3'])

    scrcpyVideoRegistry.stop('gop')
  })

  it('does not buffer deltas that arrive before the first keyframe', () => {
    scrcpyVideoRegistry.register('predelta', () => {})
    scrcpyVideoRegistry.pushFrame('predelta', {
      config: false,
      keyFrame: false,
      pts: '1',
      bytes: new ArrayBuffer(2)
    })

    const frames: string[] = []
    scrcpyVideoRegistry.subscribe('predelta', (event) => {
      if (event.type === 'frame') {
        frames.push(event.frame.pts)
      }
    })()
    expect(frames).toEqual([])
    scrcpyVideoRegistry.stop('predelta')
  })
})
