import { afterEach, describe, expect, it } from 'vitest'
import { createFakeBridgePortPair, disposeBridgePortPair } from './bridge-port-pair-test-harness'
import { storeParamsSchema } from './bridge-store-verb'
import { createPageDeviceStore } from './page-device-store'

let pair: ReturnType<typeof createFakeBridgePortPair> | null = null

afterEach(async () => {
  if (pair) {
    await disposeBridgePortPair(pair)
  }
  pair = null
})

// A shell whose store answers asynchronously, like the real one, so calls overlap in flight.
async function pageOverShellStore() {
  const rows = new Map<string, string>()
  pair = createFakeBridgePortPair({
    serveNativeVerb: async (_verb, params) => {
      await new Promise<void>((resolve) => queueMicrotask(resolve))
      const call = storeParamsSchema.parse(params)
      if (call.action === 'read') {
        return { values: call.keys.map((key) => rows.get(key) ?? null), deferred: [] }
      }
      for (const op of call.ops) {
        if (op.value === null) {
          rows.delete(op.key)
        } else {
          rows.set(op.key, op.value)
        }
      }
      return { written: true }
    }
  })
  await pair.flush()
  return { store: createPageDeviceStore(pair.client), rows }
}

describe('the page device store', () => {
  it('writes a call of more batches than the bridge has request slots', async () => {
    const { store, rows } = await pageOverShellStore()
    // 64 ops a batch: 65 batches.
    const ops = Array.from({ length: 65 * 64 }, (_op, at) => ({ key: `k-${at}`, value: 'eA==' }))

    expect(await store.write('cache', ops)).toEqual({ written: true })
    expect(rows.size).toBe(4160)
  })

  it('refuses a value over the store cap before sending any batch', async () => {
    const { store, rows } = await pageOverShellStore()

    expect(
      await store.write('cache', [
        { key: 'small', value: 'eA==' },
        { key: 'big', value: 'x'.repeat(540_000) }
      ])
    ).toEqual({ written: false, refusal: 'too-large' })
    expect([...rows.keys()]).toEqual([])
  })

  it('reads a key the store cannot hold as a miss, and refuses to write one', async () => {
    const { store } = await pageOverShellStore()
    const longKey = 'k'.repeat(513)
    await store.write('draft', [{ key: 'kept', value: 'eA==' }])

    expect(await store.read('draft', ['kept', longKey, ''])).toEqual({
      status: 'ok',
      values: ['eA==', null, null]
    })
    expect(
      await store.write('draft', [
        { key: 'kept', value: null },
        { key: longKey, value: 'eA==' }
      ])
    ).toEqual({ written: false, refusal: 'bad-key' })
    expect(await store.read('draft', ['kept'])).toEqual({ status: 'ok', values: ['eA=='] })
  })
})
