import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { abortWhenRendererGone, type RendererLifetimeSender } from './renderer-lifetime-abort'

function fakeSender(): RendererLifetimeSender & EventEmitter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: EventEmitter implements the once/on/removeListener surface this helper uses, and those three are all it calls; WebContents' overloaded signatures cannot be satisfied structurally.
  return new EventEmitter() as RendererLifetimeSender & EventEmitter
}

describe('abortWhenRendererGone', () => {
  it('aborts once a reload has replaced the document, not on in-app route changes', () => {
    const sender = fakeSender()
    const { signal } = abortWhenRendererGone(sender)

    sender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: true,
      url: 'file:///app#x'
    })
    sender.emit('did-navigate-in-page', 'file:///app#x')
    expect(signal.aborted).toBe(false)

    sender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'file:///app'
    })
    sender.emit('did-navigate', 'file:///app', 200, 'OK')
    expect(signal.aborted).toBe(true)
  })

  it('ignores a main-frame navigation that starts but is blocked before it commits', () => {
    // did-start-navigation precedes blocked external navigation; the surviving document must keep its work.
    const sender = fakeSender()
    const { signal } = abortWhenRendererGone(sender)

    sender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'https://example.invalid/'
    })
    sender.emit('will-navigate', { defaultPrevented: true }, 'https://example.invalid/')
    sender.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: 'file:///Users/me/dropped.png'
    })
    sender.emit('will-navigate', { defaultPrevented: true }, 'file:///Users/me/dropped.png')

    expect(signal.aborted).toBe(false)
  })

  it('keeps one listener per event however many lifetimes overlap on a renderer', () => {
    const sender = fakeSender()
    const lifetimes = Array.from({ length: 25 }, () => abortWhenRendererGone(sender))

    for (const event of ['destroyed', 'render-process-gone', 'did-navigate']) {
      expect(sender.listenerCount(event)).toBe(1)
    }
    lifetimes[0].dispose()
    sender.emit('did-navigate', 'file:///app', 200, 'OK')

    expect(lifetimes[0].signal.aborted).toBe(false)
    expect(lifetimes.slice(1).every(({ signal }) => signal.aborted)).toBe(true)
    expect(sender.eventNames()).toEqual([])
  })
})
