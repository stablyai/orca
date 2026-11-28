import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { LazyWorkerThreadHost } from './lazy-worker-thread-host'

it('contains an error already queued by a worker when retirement removes its owner', () => {
  const worker = Object.assign(new EventEmitter(), {
    postMessage: () => {},
    unref: () => {},
    terminate: async () => 1
  })
  const host = new LazyWorkerThreadHost({
    factory: () => worker,
    idleTeardownMs: 1_000,
    onMessage: () => {},
    onError: () => {
      throw new Error('A retired worker must not fail its replacement')
    },
    onExit: () => {},
    isIdle: () => false,
    onUnavailable: (error) => {
      throw error
    }
  })
  host.ensure()
  host.destroy()
  expect(() => worker.emit('error', new Error('queued before terminate'))).not.toThrow()
})
