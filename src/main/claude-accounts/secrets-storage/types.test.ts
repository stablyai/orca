import { describe, it, expectTypeOf } from 'vitest'
import type { SecretsStorage, SecretsBackendId, SecretsBackendProbe } from './types'

describe('SecretsStorage interface', () => {
  it('exposes read/write/delete with string keys', () => {
    expectTypeOf<SecretsStorage['read']>().toMatchTypeOf<
      (service: string, account: string) => Promise<string | null>
    >()
    expectTypeOf<SecretsStorage['write']>().toMatchTypeOf<
      (service: string, account: string, value: string) => Promise<void>
    >()
    expectTypeOf<SecretsStorage['delete']>().toMatchTypeOf<
      (service: string, account: string) => Promise<void>
    >()
    expectTypeOf<SecretsStorage['backendId']>().toMatchTypeOf<SecretsBackendId>()
  })

  it('SecretsBackendId is a literal union, not string', () => {
    expectTypeOf<SecretsBackendId>().toEqualTypeOf<'keychain' | 'encrypted-file'>()
  })

  it('SecretsBackendProbe distinguishes ok from fallback-required', () => {
    const ok: SecretsBackendProbe = { ok: true, backendId: 'keychain' }
    const fb: SecretsBackendProbe = {
      ok: false,
      reason: 'keychain-unavailable',
      message: 'libsecret missing'
    }
    expectTypeOf(ok).toMatchTypeOf<SecretsBackendProbe>()
    expectTypeOf(fb).toMatchTypeOf<SecretsBackendProbe>()
  })
})
