import { vi } from 'vitest'
import {
  AntigravityAccountService,
  type AntigravityCredentialBackend
} from './native-account-service'
import type { AntigravityAccountStore, AntigravityAccountVault } from './native-account-store'
import {
  parseAntigravityNativeCredential,
  type AntigravityCredentialIdentity
} from './native-credential-codec'

export function credential(subject: string, generation = 1, email = `${subject}@example.invalid`) {
  const claims = {
    iss: 'https://accounts.google.com',
    sub: subject,
    email,
    email_verified: true,
    iat: generation
  }
  return JSON.stringify({
    auth_method: 'consumer',
    id_token: `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`,
    token: {
      access_token: `synthetic-${generation}`,
      refresh_token: `refresh-${generation}`,
      expiry: `2030-01-01T00:00:${String(generation).padStart(2, '0')}Z`
    },
    future_field: { generation, preserved: true }
  })
}

// agy's refresh keeps the grant's refresh_token but stores no id_token (agy 1.4.7).
export function refreshedWithoutIdToken(generation: number, refreshToken = 'refresh-1') {
  return JSON.stringify({
    auth_method: 'consumer',
    id_token_email: 'a@example.invalid',
    token: {
      access_token: `synthetic-${generation}`,
      refresh_token: refreshToken,
      expiry: `2030-01-01T00:00:${String(generation).padStart(2, '0')}Z`
    }
  })
}

/** `keychain`: agy's login sits where reading it may raise a dialog, as in the macOS keychain;
 *  its fingerprint changes with every write. */
export function harness(initial: string | null = credential('a'), { keychain = false } = {}) {
  let native = initial
  let revision = 0
  let signInHeld = false
  let vault: AntigravityAccountVault = { accounts: [], selectedAccountId: null }
  const store: AntigravityAccountStore = {
    read: vi.fn(async () => structuredClone(vault)),
    write: vi.fn(async (next) => {
      vault = structuredClone(next)
    })
  }
  const backend: AntigravityCredentialBackend = {
    read: vi.fn(async () => (native ? parseAntigravityNativeCredential(native) : null)),
    write: vi.fn(async (contents, expected) => {
      if (native !== expected) {
        throw new Error('native conflict')
      }
      native = contents
      revision++
    }),
    ...(keychain
      ? {
          readWithoutPrompt: vi.fn(async () =>
            native
              ? { fingerprint: `revision-${revision}`, stableFrom: 0, settled: true }
              : { credential: null }
          )
        }
      : {})
  }
  const lookupIdentity = vi.fn<(accessToken: string) => Promise<AntigravityCredentialIdentity>>(
    async () => {
      throw new Error('Google did not confirm')
    }
  )
  return {
    store,
    backend,
    lookupIdentity,
    service: new AntigravityAccountService(store, backend, Date.now, lookupIdentity, {
      signInHoldsLogin: () => signInHeld
    }),
    setSignInHeld: (held: boolean) => {
      signInHeld = held
    },
    setNative: (contents: string | null) => {
      native = contents
      revision++
    },
    getNative: () => native,
    getVault: () => structuredClone(vault)
  }
}
