import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkerRequestTransport } from '../lazy-worker-thread-host'
import { ForeignSqliteReaderClient } from './foreign-sqlite-reader-client'

// Ported from the dedicated Cursor worker's tests (#24572), against the shared client.

const FAILURE = { status: 'error', error: 'Unable to read the Cursor desktop login' }
const MISSING = { status: 'missing' }
const ANSWER_MISSING = `const { parentPort } = require('node:worker_threads');
  parentPort.on('message', ({ id }) => parentPort.postMessage({ id, ok: true, value: { status: 'missing' } }));`

const clients: ForeignSqliteReaderClient[] = []
afterEach(() => clients.splice(0).forEach((client) => client.dispose()))

// The host clears retirement a few microtasks after terminate() settles.
function afterRetirement(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function makeClient(
  workerFactory: () => WorkerRequestTransport,
  timeoutMs?: number
): ForeignSqliteReaderClient {
  const client = new ForeignSqliteReaderClient({ workerFactory, log() {}, timeoutMs })
  clients.push(client)
  return client
}

describe('ForeignSqliteReaderClient worker lifecycle', () => {
  it('keeps the caller responsive during a slow read and coalesces concurrent probes', async () => {
    let spawns = 0
    const client = makeClient(() => {
      spawns++
      return new Worker(
        `const { parentPort } = require('node:worker_threads');
         parentPort.on('message', ({ id }) => {
           Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
           parentPort.postMessage({ id, ok: true, value: { status: 'missing' } });
         });`,
        { eval: true }
      )
    })
    const pending = client.readCursorProfile('/synthetic/state.vscdb')
    expect(client.readCursorProfile('/synthetic/state.vscdb')).toBe(pending)
    let completed = false
    void pending.then(() => {
      completed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(completed).toBe(false)
    expect(await pending).toEqual(MISSING)
    expect(spawns).toBe(1)
  })

  it('fails closed on unavailable workers without exposing filesystem details', async () => {
    const client = makeClient(() => {
      throw new Error('/private/account/path')
    })
    expect(await client.readCursorProfile('/private/account/state.vscdb')).toEqual(FAILURE)
  })

  it('terminates a stalled worker and allows a subsequent read to recover', async () => {
    const workers: Worker[] = []
    const client = makeClient(() => {
      const worker = new Worker(
        workers.length === 0 ? 'setInterval(() => {}, 1000)' : ANSWER_MISSING,
        { eval: true }
      )
      workers.push(worker)
      return worker
    }, 200)
    expect(await client.readCursorProfile('/synthetic/state.vscdb')).toEqual(FAILURE)
    await workers[0]?.terminate()
    await afterRetirement()
    expect(await client.readCursorProfile('/synthetic/state.vscdb')).toEqual(MISSING)
    expect(workers).toHaveLength(2)
  })

  // Every reader shares the lane, so each must keep the retirement gate.
  it.each([
    {
      reader: 'cursorProfile',
      read: (client: ForeignSqliteReaderClient) =>
        client.readCursorProfile('/synthetic/state.vscdb'),
      failure: FAILURE,
      answer: MISSING
    },
    {
      reader: 'openCodeBinderSessions',
      read: (client: ForeignSqliteReaderClient) =>
        client.readOpenCodeBinderSessions('/synthetic/opencode.db', { ms: 0, id: '' }),
      failure: [],
      answer: [{ id: 'ses_a', directory: '/w', createdAtMs: 1, parentId: null }]
    }
  ])(
    '$reader refuses new native workers until the retired worker positively terminates',
    async ({ read, failure, answer }) => {
      let spawns = 0
      let finishRetirement: (code: number) => void = () => {}
      const retirement = new Promise<number>((resolve) => {
        finishRetirement = resolve
      })
      const events = new EventEmitter()
      const client = makeClient(() => {
        spawns++
        return {
          on: (...args) => events.on(...args),
          off: (...args) => events.off(...args),
          removeAllListeners: () => events.removeAllListeners(),
          unref: () => undefined,
          terminate: () => retirement,
          postMessage: (request: { id: number }) => {
            if (spawns > 1) {
              queueMicrotask(() =>
                events.emit('message', { id: request.id, ok: true, value: answer })
              )
            }
          }
        }
      }, 20)
      expect(await read(client)).toEqual(failure)
      for (let i = 0; i < 3; i++) {
        expect(await read(client)).toEqual(failure)
      }
      expect(spawns).toBe(1)
      finishRetirement(1)
      await retirement
      await afterRetirement()
      expect(await read(client)).toEqual(answer)
      expect(spawns).toBe(2)
    }
  )

  it('settles pending reads when disposed', async () => {
    const client = makeClient(() => new Worker('setInterval(() => {}, 1000)', { eval: true }))
    const pending = client.readCursorProfile('/synthetic/state.vscdb')
    client.dispose()
    expect(await pending).toEqual(FAILURE)
  })
})
