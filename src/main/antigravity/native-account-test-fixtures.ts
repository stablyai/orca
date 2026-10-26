import { vi } from 'vitest'
import {
  AntigravityAccountService,
  type AntigravityCredentialBackend
} from './native-account-service'
import type { AntigravityAccountStore, AntigravityAccountVault } from './native-account-store'
import { parseAntigravityNativeCredential } from './native-credential-codec'

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
      expiry: generation
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
      expiry: generation
    }
  })
}

export function harness(initial: string | null = credential('a')) {
  let native = initial
  let vault: AntigravityAccountVault = { accounts: [], selectedAccountId: null }
  const store: AntigravityAccountStore = {
    read: vi.fn(() => structuredClone(vault)),
    write: vi.fn((next) => {
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
    })
  }
  return {
    store,
    backend,
    service: new AntigravityAccountService(store, backend),
    setNative: (contents: string | null) => {
      native = contents
    },
    getNative: () => native,
    getVault: () => structuredClone(vault)
  }
}
