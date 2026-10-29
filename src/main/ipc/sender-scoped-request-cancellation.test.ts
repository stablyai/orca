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
  it.each(lifetimeEvents)(
    'aborts every owned request on %s and preserves another sender',
    (name) => {
      const registry = createSenderScopedRequestCancellations()
      const first = requestEvent(1)
      const second = requestEvent(2)
      const firstRequests = ['one', 'two'].map((token) => registry.begin(first.event, token))
      const secondRequest = registry.begin(second.event, 'one')

      first.sender.emit(name)

      expect(firstRequests.map((request) => request?.signal.aborted)).toEqual([true, true])
      expect(secondRequest?.signal.aborted).toBe(false)
      for (const eventName of lifetimeEvents) {
        expect(first.sender.listenerCount(eventName)).toBe(0)
      }
      registry.finish(second.event, 'one', secondRequest)
    }
  )

  it('keeps only one set of lifecycle listeners for concurrent requests', () => {
    const registry = createSenderScopedRequestCancellations()
    const { event, sender } = requestEvent()
    const controllers = Array.from({ length: 100 }, (_, index) => registry.begin(event, `${index}`))

    for (const name of lifetimeEvents) {
      expect(sender.listenerCount(name)).toBe(1)
    }
    controllers.forEach((controller, index) => registry.finish(event, `${index}`, controller))
    for (const name of lifetimeEvents) {
      expect(sender.listenerCount(name)).toBe(0)
    }
    expect(controllers.some((controller) => controller?.signal.aborted)).toBe(false)
  })

  it('does not accumulate live requests across repeated document replacements', () => {
    const registry = createSenderScopedRequestCancellations()
    const { event, sender } = requestEvent()
    const controllers: AbortController[] = []
    for (let generation = 0; generation < 16; generation++) {
      if (generation > 0) {
        sender.emit('did-navigate')
      }
      for (let request = 0; request < 100; request++) {
        const controller = registry.begin(event, `${generation}:${request}`)
        if (controller) {
          controllers.push(controller)
        }
      }
    }

    expect(controllers.filter((controller) => !controller.signal.aborted)).toHaveLength(100)
    for (const name of lifetimeEvents) {
      expect(sender.listenerCount(name)).toBe(1)
    }
    sender.emit('destroyed')
    expect(controllers.every((controller) => controller.signal.aborted)).toBe(true)
  })

  it('preserves requests across same-document or prevented navigation', () => {
    const registry = createSenderScopedRequestCancellations()
    const { event, sender } = requestEvent()
    const controller = registry.begin(event, 'one')

    sender.emit('did-start-navigation')
    sender.emit('will-navigate', { defaultPrevented: true })
    sender.emit('did-navigate-in-page')

    expect(controller?.signal.aborted).toBe(false)
    registry.finish(event, 'one', controller)
  })

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

  it('does not let a prior document finish remove the current document owner', () => {
    const registry = createSenderScopedRequestCancellations()
    const { event, sender } = requestEvent()
    const old = registry.begin(event, 'one')
    sender.emit('did-navigate')
    const current = registry.begin(event, 'one')

    registry.finish(event, 'one', old)
    expect(current?.signal.aborted).toBe(false)
    sender.emit('render-process-gone')

    expect(current?.signal.aborted).toBe(true)
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

  it('preserves the no-token opt-out and ignores unknown cancellation', () => {
    const registry = createSenderScopedRequestCancellations()
    const { event, sender } = requestEvent()

    expect(registry.begin(event, undefined)).toBeNull()
    expect(registry.begin(event, '')).toBeNull()
    registry.finish(event, undefined, null)
    registry.cancel(event, 'unknown')
    for (const name of lifetimeEvents) {
      expect(sender.listenerCount(name)).toBe(0)
    }
  })
})
