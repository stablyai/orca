import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  abortWhenRendererGone,
  RENDERER_GONE_MESSAGE,
  type RendererLifetimeSender
} from './renderer-lifetime-abort'

function fakeSender(): RendererLifetimeSender & EventEmitter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: EventEmitter implements the once/on/removeListener surface this helper uses, and those three are all it calls; WebContents' overloaded signatures cannot be satisfied structurally.
  return new EventEmitter() as RendererLifetimeSender & EventEmitter
}

describe('abortWhenRendererGone', () => {
  it('aborts when the renderer is destroyed', () => {
    const sender = fakeSender()
    const { signal } = abortWhenRendererGone(sender)

    expect(signal.aborted).toBe(false)
    sender.emit('destroyed')

    expect(signal.aborted).toBe(true)
    expect(String(signal.reason)).toContain(RENDERER_GONE_MESSAGE)
  })

  it('aborts when the render process is gone', () => {
    const sender = fakeSender()
    const { signal } = abortWhenRendererGone(sender)

    sender.emit('render-process-gone')

    expect(signal.aborted).toBe(true)
  })

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
    // Why: Electron emits did-start-navigation before will-navigate gets to
    // preventDefault() an external link or a stray file drop; the renderer
    // document survives those, so the upload must too.
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

  it('leaves no listeners on a long-lived renderer once disposed', () => {
    const sender = fakeSender()
    const { dispose } = abortWhenRendererGone(sender)

    expect(sender.listenerCount('destroyed')).toBe(1)
    dispose()
    dispose()

    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
    expect(sender.listenerCount('did-navigate')).toBe(0)
  })
})
