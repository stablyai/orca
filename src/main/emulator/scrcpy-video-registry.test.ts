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
    expect(events).toEqual(['meta', 'frame'])

    scrcpyVideoRegistry.pushFrame('dev', frame(false))
    expect(events).toEqual(['meta', 'frame', 'frame'])

    unsubscribe()
    scrcpyVideoRegistry.pushFrame('dev', frame(false))
    expect(events).toEqual(['meta', 'frame', 'frame'])

    scrcpyVideoRegistry.stop('dev')
    expect(close).toHaveBeenCalledTimes(1)
    expect(scrcpyVideoRegistry.has('dev')).toBe(false)
  })

  it('tells live and late subscribers that the session ended', () => {
    scrcpyVideoRegistry.register('ended', () => {})
    const live: ScrcpyVideoEvent['type'][] = []
    scrcpyVideoRegistry.subscribe('ended', (event) => live.push(event.type))

    scrcpyVideoRegistry.stop('ended')
    expect(live).toEqual(['end'])

    const late: ScrcpyVideoEvent['type'][] = []
    scrcpyVideoRegistry.subscribe('ended', (event) => late.push(event.type))
    expect(late).toEqual(['end'])
  })

  it('routes control only to the live session registered for the device', () => {
    const control = { videoSize: () => null, sendControl: () => true }
    scrcpyVideoRegistry.attachControl('ctl', control)
    expect(scrcpyVideoRegistry.control('ctl')).toBeNull()

    scrcpyVideoRegistry.register('ctl', () => {})
    scrcpyVideoRegistry.attachControl('ctl', control)
    expect(scrcpyVideoRegistry.control('ctl')).toBe(control)

    // A replacement session must not inherit the previous server's control socket.
    scrcpyVideoRegistry.register('ctl', () => {})
    expect(scrcpyVideoRegistry.control('ctl')).toBeNull()
    scrcpyVideoRegistry.attachControl('ctl', control)
    scrcpyVideoRegistry.stop('ctl')
    expect(scrcpyVideoRegistry.control('ctl')).toBeNull()
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
