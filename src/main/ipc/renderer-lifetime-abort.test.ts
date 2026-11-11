import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { abortWhenRendererGone } from './renderer-lifetime-abort'
import type { FanoutEventSource } from '../runtime/events/event-listener-fanout'

function fakeSender(): FanoutEventSource & EventEmitter {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: EventEmitter implements the once/on/removeListener surface this helper uses, and those three are all it calls; WebContents' overloaded signatures cannot be satisfied structurally.
  return new EventEmitter() as FanoutEventSource & EventEmitter
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
})
