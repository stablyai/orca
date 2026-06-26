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
})
