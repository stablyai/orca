import { Worker } from 'node:worker_threads'
import { getVersion } from 'sucrase'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPluginSourceTranspileClient,
  type PluginSourceTranspileWorker
} from './plugin-source-transpile-client'
import { PLUGIN_SOURCE_TRANSPILER_ID } from './plugin-source-transpile-protocol'

// Real threads: echoes `source` back, except that "hang" busy-loops the thread forever.
const FAKE_TRANSPILER = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', ({ id, source }) => {
  if (source === 'hang') { for (;;) {} }
  parentPort.postMessage({ id, result: { ok: true, code: source, imports: [] } })
})`

const workers: Worker[] = []
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()))
})

function fakeWorkers(): { create: () => PluginSourceTranspileWorker; created: () => number } {
  return {
    create: () => {
      const worker = new Worker(FAKE_TRANSPILER, { eval: true })
      workers.push(worker)
      return worker
    },
    created: () => workers.length
  }
}

describe('plugin source transpile client', () => {
  it('keeps one warm worker for successive files', async () => {
    const fake = fakeWorkers()
    const transpile = createPluginSourceTranspileClient({ createWorker: fake.create })
    await expect(transpile('a.ts', 'one')).resolves.toEqual({ ok: true, code: 'one', imports: [] })
    await expect(transpile('b.ts', 'two')).resolves.toMatchObject({ code: 'two' })
    expect(fake.created()).toBe(1)
  })

  it('cuts a transform over the budget short, terminates its thread and starts a new one', async () => {
    const fake = fakeWorkers()
    const transpile = createPluginSourceTranspileClient({
      createWorker: fake.create,
      budgetMs: 200
    })
    // The thread never answers, so resolving at all means the budget cut it short.
    const hung = transpile('slow.ts', 'hang')
    const after = transpile('next.ts', 'fine')
    await expect(hung).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('200 ms transpile budget')
    })
    // The busy-looping thread is gone; the queued file runs on a fresh one.
    await expect(after).resolves.toMatchObject({ ok: true, code: 'fine' })
    expect(fake.created()).toBe(2)
  })

  it('reports a worker that cannot start instead of throwing', async () => {
    const transpile = createPluginSourceTranspileClient({
      createWorker: () => {
        throw new Error('no entry')
      }
    })
    await expect(transpile('a.ts', 'x')).resolves.toEqual({ ok: false, message: 'no entry' })
  })

  it('names the bundled sucrase in the cache key', () => {
    expect(PLUGIN_SOURCE_TRANSPILER_ID).toBe(`sucrase@${getVersion()}`)
  })
})
