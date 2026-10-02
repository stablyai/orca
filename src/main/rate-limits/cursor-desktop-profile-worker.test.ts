import { Worker } from 'node:worker_threads'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { CursorDesktopProfileWorker } from './cursor-desktop-profile-worker'

const clients: CursorDesktopProfileWorker[] = []
afterEach(() => clients.splice(0).forEach((client) => client.dispose()))

describe('Cursor desktop login worker', () => {
  it('keeps the caller responsive during a slow read and coalesces concurrent probes', async () => {
    let spawns = 0
    const client = new CursorDesktopProfileWorker(() => {
      spawns++
      return new Worker(
        `const { parentPort } = require('node:worker_threads');
         parentPort.on('message', ({id}) => {
           Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
           parentPort.postMessage({id, result: {status: 'missing'}});
         });`,
        { eval: true }
      )
    })
    clients.push(client)
    const pending = client.read('/synthetic/state.vscdb')
    expect(client.read('/synthetic/state.vscdb')).toBe(pending)
    let completed = false
    void pending.then(() => {
      completed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(completed).toBe(false)
    expect(await pending).toEqual({ status: 'missing' })
    expect(spawns).toBe(1)
  })

  it('fails closed on unavailable workers without exposing filesystem details', async () => {
    const client = new CursorDesktopProfileWorker(() => {
      throw new Error('/private/account/path')
    })
    clients.push(client)
    expect(await client.read('/private/account/state.vscdb')).toEqual({
      status: 'error',
      error: 'Unable to read the Cursor desktop login'
    })
  })

  it('terminates a stalled worker and allows a subsequent read to recover', async () => {
    let spawns = 0
    const workers: Worker[] = []
    const client = new CursorDesktopProfileWorker(() => {
      spawns++
      const worker = new Worker(
        spawns === 1
          ? `setInterval(() => {}, 1000)`
          : `const {parentPort} = require('node:worker_threads');
             parentPort.on('message', ({id}) => parentPort.postMessage({id, result: {status: 'missing'}}));`,
        { eval: true }
      )
      workers.push(worker)
      return worker
    }, 200)
    clients.push(client)
    expect((await client.read('/synthetic/state.vscdb')).status).toBe('error')
    await workers[0]?.terminate()
    expect(await client.read('/synthetic/state.vscdb')).toEqual({
      status: 'missing'
    })
    expect(spawns).toBe(2)
  })

  it('refuses new native workers until the retired worker positively terminates', async () => {
    let spawns = 0
    let finishRetirement: ((code: number) => void) | undefined
    const retirement = new Promise<number>((resolve) => {
      finishRetirement = resolve
    })
    const events = new EventEmitter()
    const client = new CursorDesktopProfileWorker(() => {
      spawns++
      return {
        on: (...args) => events.on(...args),
        off: (...args) => events.off(...args),
        removeAllListeners: () => events.removeAllListeners(),
        unref: () => undefined,
        terminate: () => retirement,
        postMessage: (request) => {
          if (spawns > 1) {
            queueMicrotask(() =>
              events.emit('message', { id: request.id, result: { status: 'missing' } })
            )
          }
        }
      }
    }, 20)
    clients.push(client)
    expect((await client.read('/synthetic/state.vscdb')).status).toBe('error')
    for (let i = 0; i < 3; i++) {
      expect((await client.read('/synthetic/state.vscdb')).status).toBe('error')
    }
    expect(spawns).toBe(1)
    finishRetirement?.(1)
    await retirement
    expect(await client.read('/synthetic/state.vscdb')).toEqual({ status: 'missing' })
    expect(spawns).toBe(2)
  })

  it('settles pending reads when disposed', async () => {
    const client = new CursorDesktopProfileWorker(
      () => new Worker('setInterval(() => {}, 1000)', { eval: true })
    )
    const pending = client.read('/synthetic/state.vscdb')
    client.dispose()
    expect((await pending).status).toBe('error')
  })
})
