import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'

function requestEvent(id = 1) {
  const sender = Object.assign(new EventEmitter(), { id })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The registry only reads sender.id and its EventEmitter lifetime methods.
  const event = { sender } as unknown as IpcMainInvokeEvent
  return { sender, event }
}

const lifetimeEvents = ['destroyed', 'render-process-gone', 'did-navigate'] as const

describe('sender-scoped request lifetime', () => {
  it('keeps the replacement when an old request finishes late', () => {
    const registry = createSenderScopedRequestCancellations()
    const { event, sender } = requestEvent()
    const old = registry.begin(event, 'one')
    const replacement = registry.begin(event, 'one')
    expect(old?.signal.aborted).toBe(true)

    registry.finish(event, 'one', old)
    registry.cancel(event, 'one')

    expect(replacement?.signal.aborted).toBe(true)
    registry.finish(event, 'one', replacement)
    for (const name of lifetimeEvents) {
      expect(sender.listenerCount(name)).toBe(0)
    }
  })

  it('allows synchronous finish callbacks while aborting the owner', () => {
    const registry = createSenderScopedRequestCancellations()
    const { event, sender } = requestEvent()
    const first = registry.begin(event, 'one')
    const second = registry.begin(event, 'two')
    first?.signal.addEventListener('abort', () => registry.finish(event, 'one', first))
    second?.signal.addEventListener('abort', () => registry.finish(event, 'two', second))

    sender.emit('destroyed')

    expect(first?.signal.aborted).toBe(true)
    expect(second?.signal.aborted).toBe(true)
    for (const name of lifetimeEvents) {
      expect(sender.listenerCount(name)).toBe(0)
    }
  })
})
