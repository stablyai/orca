import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _resetSecretStoreForTests,
  setSecretStore,
  type SecretStore
} from '../../../shared/secure-storage/secret-store'
import { isStoredRelayGrant, RelayGrants, type StoredRelayGrant } from './bot-tool-relay-grants'
import { RELAY_UNLOCK_RETRY_MS, RelaySealedFile, RelayUnlockThrottle } from './relay-sealed-file'
import { jsonProperty } from '../../../shared/json-stream/json-value-property'

/**
 * A keychain that seals by reversing the bytes, and can be locked or downgraded. Its sync decrypt is
 * dead, as Linux's stays once the keyring was locked at startup: only the async path opens entries.
 */
const keychain: {
  locked: boolean
  sealing: 'os-keychain' | 'none'
  opens: number
  /** Holds each decrypt's answer until it settles. */
  answer: Promise<void>
} = { locked: false, sealing: 'os-keychain', opens: 0, answer: Promise.resolve() }
const store: SecretStore = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(Buffer.from(plain, 'utf8').toReversed()),
  decryptString: () => {
    throw new Error('sync decrypt unavailable')
  },
  decryptStringAsync: async (cipher) => {
    keychain.opens += 1
    await keychain.answer
    if (keychain.locked) {
      throw new Error('keychain locked')
    }
    return Buffer.from(cipher.toReversed()).toString('utf8')
  },
  describeProtectionGap: () => (keychain.sealing === 'os-keychain' ? null : 'basic_text'),
  describeSealing: () =>
    keychain.sealing === 'os-keychain' ? { kind: 'os-keychain' } : { kind: 'none', reason: 'x' }
}

let dir: string
let path: string
let clock = 0

const grantsAt = (current?: (owner: string) => { bot?: string } | null) => {
  const grants = new RelayGrants(new RelayUnlockThrottle(() => clock))
  grants.configure(new RelaySealedFile(path, isStoredRelayGrant), current)
  return grants
}
const fileEntries = (): StoredRelayGrant[] => {
  const entries = jsonProperty(JSON.parse(readFileSync(path, 'utf8')), 'entries')
  return Array.isArray(entries) ? entries.filter(isStoredRelayGrant) : []
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relay-grants-'))
  path = join(dir, 'bot-tool-relay-grants.json')
  Object.assign(keychain, {
    locked: false,
    sealing: 'os-keychain',
    opens: 0,
    answer: Promise.resolve()
  })
  clock = 0
  setSecretStore(store)
})

afterEach(() => {
  _resetSecretStoreForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe('kept relay grants', () => {
  it('keeps a token sealed across runs, and a revoke removes it from the file before it ends', async () => {
    const first = grantsAt()
    const token = first.grant('scout', { bot: '/bots/scout' })
    expect(await first.keep('scout')).toBe(true)
    // Durable before keep resolved, and never in the clear.
    expect(readFileSync(path, 'utf8')).not.toContain(token)

    const next = grantsAt((owner) => (owner === 'scout' ? { bot: '/bots/scout' } : null))
    await next.load()
    expect(next.of(token)?.owner).toBe('scout')
    expect(next.grant('scout', { bot: '/bots/scout' })).toBe(token)

    await next.revoke('scout')
    expect(fileEntries()).toEqual([])
    expect(next.of(token)).toBeUndefined()
  })

  it('drops a deleted bot at load and keeps nothing without OS-backed sealing', async () => {
    const first = grantsAt()
    first.grant('gone', { bot: '/bots/gone' })
    await first.keep('gone')
    await grantsAt(() => null).load()
    expect(fileEntries()).toEqual([])

    keychain.sealing = 'none'
    const weak = grantsAt()
    weak.grant('scout', { bot: '/bots/scout' })
    expect(await weak.keep('scout')).toBe(false)
    expect(fileEntries()).toEqual([])
  })

  it('keeps a locked entry as written, and retries opening it at most once per 10 s', async () => {
    const first = grantsAt()
    const token = first.grant('scout', { bot: '/bots/scout' })
    await first.keep('scout')
    const written = readFileSync(path, 'utf8')

    keychain.locked = true
    const next = grantsAt()
    await next.load()
    expect(next.of(token)).toBeUndefined()
    expect(next.holds('scout')).toBe(true)
    // A new launch for a locked owner stays memory-only.
    next.grant('scout', { bot: '/bots/scout' })
    expect(await next.keep('scout')).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(written)

    const opensAfterLoad = keychain.opens
    expect(await next.unlock(token)).toBe('locked')
    // A flood of unknown tokens inside the window never reaches the keychain again.
    for (let index = 0; index < 100; index += 1) {
      expect(await next.unlock(`unknown-${index}`)).toBe('locked')
    }
    expect(keychain.opens).toBe(opensAfterLoad + 1)

    keychain.locked = false
    clock += RELAY_UNLOCK_RETRY_MS
    expect(await next.unlock(token)).toMatchObject({ owner: 'scout' })
    expect(await next.unlock('unknown')).toBeUndefined()
  })

  it('a revoke while the keychain answers a retry never brings the token back', async () => {
    const first = grantsAt()
    const token = first.grant('scout', { bot: '/bots/scout' })
    await first.keep('scout')
    keychain.locked = true
    const next = grantsAt()
    await next.load()

    keychain.locked = false
    clock += RELAY_UNLOCK_RETRY_MS
    let answer = (): void => {}
    keychain.answer = new Promise((resolve) => (answer = resolve))
    const retry = next.unlock(token)
    await next.revoke('scout')
    answer()
    expect(await retry).toBeUndefined()
    expect(next.of(token)).toBeUndefined()
    expect(next.holds('scout')).toBe(false)
  })
})
