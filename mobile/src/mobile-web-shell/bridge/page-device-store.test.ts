import { afterEach, describe, expect, it } from 'vitest'
import { MOBILE_WEB_SHELL_GRANTS } from '../page-route-policy'
import { createFakeBridgePortPair, disposeBridgePortPair } from './bridge-port-pair-test-harness'
import { createPageDeviceStore } from './page-device-store'
import { storeParamsSchema } from './bridge-store-verb'

let pair: ReturnType<typeof createFakeBridgePortPair> | null = null

afterEach(async () => {
  if (pair) {
    await disposeBridgePortPair(pair)
  }
  pair = null
})

describe('the page device store', () => {
  it('answers unavailable without asking a shell that did not grant the verb', async () => {
    pair = createFakeBridgePortPair({
      routeGrants: MOBILE_WEB_SHELL_GRANTS.filter((grant) => grant !== 'native.store.rows')
    })
    await pair.flush()
    const store = createPageDeviceStore(pair.client)

    expect(await store.read('cache', ['q-1'])).toEqual({ status: 'unavailable' })
    expect(await store.write('draft', [{ key: 'draft:chat::t', value: 'dHlwZWQ=' }])).toEqual({
      written: false,
      refusal: 'unavailable'
    })
    expect(pair.toShell.filter((json) => json.includes('"native.store.rows"'))).toEqual([])
  })

  it('reads deferred keys again until every value is in hand', async () => {
    const stored: Record<string, string> = { a: 'QQ==', b: 'Qg==', c: 'Qw==' }
    pair = createFakeBridgePortPair({
      // Fills only the first key of each read, like a reply that hit its budget.
      serveNativeVerb: async (_verb, params) => {
        const call = storeParamsSchema.parse(params)
        const keys = call.action === 'read' ? call.keys : []
        return {
          values: keys.map((key, at) => (at === 0 ? stored[key] : null)),
          deferred: keys.slice(1).map((_key, at) => at + 1)
        }
      }
    })
    await pair.flush()
    const store = createPageDeviceStore(pair.client)

    expect(await store.read('cache', ['a', 'b', 'c'])).toEqual({
      status: 'ok',
      values: ['QQ==', 'Qg==', 'Qw==']
    })
  })
})
