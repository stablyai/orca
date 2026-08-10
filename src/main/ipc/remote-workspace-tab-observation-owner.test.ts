import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { RemoteWorkspaceTabObservationOwnerRegistry } from './remote-workspace-tab-observation-owner'

class Sender extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
}

describe('RemoteWorkspaceTabObservationOwnerRegistry', () => {
  it('binds generations to the Electron sender and process incarnation', () => {
    const registry = new RemoteWorkspaceTabObservationOwnerRegistry()
    const sender = new Sender(7)
    const first = registry.start(sender, 100)
    const second = registry.start(sender, 101)

    expect(registry.resolve(sender, 100, first)).toBeNull()
    expect(registry.resolve(sender, 101, first)).toBeNull()
    expect(registry.resolve(sender, 101, second)).toEqual({
      processId: 101,
      rendererGeneration: second,
      senderId: 7
    })
  })

  it.each(['render-process-gone', 'destroyed'])('revokes the lease on %s', (event) => {
    const registry = new RemoteWorkspaceTabObservationOwnerRegistry()
    const sender = new Sender(7)
    const generation = registry.start(sender, 100)

    sender.emit(event)

    expect(registry.resolve(sender, 100, generation)).toBeNull()
    expect(sender.listenerCount('destroyed')).toBe(0)
    expect(sender.listenerCount('render-process-gone')).toBe(0)
  })

  it('never accepts a generation issued to a different Electron sender', () => {
    const registry = new RemoteWorkspaceTabObservationOwnerRegistry()
    const first = new Sender(7)
    const second = new Sender(8)
    const generation = registry.start(first, 100)

    expect(registry.resolve(second, 100, generation)).toBeNull()
  })
})
