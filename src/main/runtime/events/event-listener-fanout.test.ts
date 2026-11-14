import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { addFanoutListener, addFanoutListeners } from './event-listener-fanout'

describe('addFanoutListener', () => {
  it('shares one native listener across overlapping subscribers and returns to baseline', () => {
    const source = new EventEmitter()
    const callbacks = Array.from({ length: 25 }, () => vi.fn())
    const releases = callbacks.map((callback) => addFanoutListener(source, 'destroyed', callback))

    expect(source.listenerCount('destroyed')).toBe(1)
    source.emit('destroyed', 'arg')
    for (const callback of callbacks) {
      expect(callback).toHaveBeenCalledWith('arg')
    }

    for (const release of releases.slice(1)) {
      release()
    }
    expect(source.listenerCount('destroyed')).toBe(1)
    releases[0]()
    releases[0]()
    expect(source.eventNames()).toEqual([])
  })

  it('lets the same callback subscribe twice without one release dropping the other', () => {
    const source = new EventEmitter()
    const callback = vi.fn()
    const releaseFirst = addFanoutListener(source, 'closed', callback)
    addFanoutListener(source, 'closed', callback)

    releaseFirst()
    source.emit('closed')

    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('skips subscribers released by an earlier callback in the same dispatch', () => {
    const source = new EventEmitter()
    const second = vi.fn()
    let releaseSecond = (): void => {}
    addFanoutListener(source, 'destroyed', () => releaseSecond())
    releaseSecond = addFanoutListener(source, 'destroyed', second)

    source.emit('destroyed')

    expect(second).not.toHaveBeenCalled()
  })

  it('reattaches a fresh native listener after the last subscriber left', () => {
    const source = new EventEmitter()
    addFanoutListener(source, 'destroyed', vi.fn())()
    const callback = vi.fn()
    addFanoutListener(source, 'destroyed', callback)

    source.emit('destroyed')

    expect(source.listenerCount('destroyed')).toBe(1)
    expect(callback).toHaveBeenCalledOnce()
  })
})

describe('addFanoutListeners', () => {
  it('releases every event with one call', () => {
    const source = new EventEmitter()
    const release = addFanoutListeners(source, ['destroyed', 'render-process-gone'], vi.fn())

    expect(source.eventNames().sort()).toEqual(['destroyed', 'render-process-gone'])
    release()
    release()

    expect(source.eventNames()).toEqual([])
  })
})
