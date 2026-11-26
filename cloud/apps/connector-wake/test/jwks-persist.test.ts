// A malformed 200 from auth must not replace the colo's last good key set.
import { exportJWK, generateKeyPair } from 'jose'
import { afterEach, expect, it, vi } from 'vitest'
import { persistingFetch, readPersistedJwks } from '../src/jwks-persist'

afterEach(() => vi.unstubAllGlobals())

it('keeps the last good set when auth serves one jose would refuse', async () => {
  const store = new Map<string, Response>()
  vi.stubGlobal('caches', {
    default: {
      put: async (req: Request, res: Response) => void store.set(req.url, res),
      match: async (req: Request) => store.get(req.url)?.clone()
    }
  })
  const { publicKey } = await generateKeyPair('ES256')
  const good = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'ES256' }] }
  const url = 'https://auth.test.invalid/jwks'
  const bodies = [JSON.stringify(good), '{"keys":[null]}']
  vi.stubGlobal('fetch', async () => new Response(bodies.shift(), { status: 200 }))
  const fetchKeys = persistingFetch(url)
  await fetchKeys(url, {})
  await fetchKeys(url, {})
  expect(await readPersistedJwks(url)).toEqual(good)
})
