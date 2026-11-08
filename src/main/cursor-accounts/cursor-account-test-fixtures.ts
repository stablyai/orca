import { vi } from 'vitest'
import type { CursorCredentialBackend } from './cursor-macos-credential-backend'
import type { CursorAccountStore, CursorAccountVault } from './cursor-account-store'
import {
  projectCursorCredential,
  type CursorCredentialSnapshot,
  type CursorNativeCredential
} from './cursor-native-credential'
import { CursorAccountService } from './cursor-account-service'

/** Unsigned JWT: the app only reads `sub`/`exp`, never verifies a signature. */
export function cursorJwt(subject: string, generation = 1): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject, exp: 2_000_000_000 + generation }))
  return `e30.${payload.toString('base64url')}.sig${generation}`
}

export function cursorSnapshot(
  subject: string,
  generation = 1,
  overrides: Partial<CursorCredentialSnapshot> = {}
): CursorCredentialSnapshot {
  return {
    accessToken: cursorJwt(subject, generation),
    refreshToken: `refresh-${subject}-${generation}`,
    apiKey: null,
    authInfo: { email: `${subject}@example.invalid`, displayName: `Name ${subject}` },
    ...overrides
  }
}

export function harness(initial: CursorCredentialSnapshot | null = cursorSnapshot('user_a')) {
  let native: CursorNativeCredential | null = initial ? projectCursorCredential(initial) : null
  let vault: CursorAccountVault = { accounts: [], selectedAccountId: null }
  const store: CursorAccountStore = {
    read: vi.fn(() => structuredClone(vault)),
    write: vi.fn((next) => {
      vault = structuredClone(next)
    })
  }
  const backend: CursorCredentialBackend = {
    read: vi.fn(async () => native),
    write: vi.fn(async (snapshot, expectedAccessToken) => {
      if ((native?.snapshot.accessToken ?? null) !== expectedAccessToken) {
        throw new Error('native conflict')
      }
      native = projectCursorCredential(snapshot)
    })
  }
  let tick = 1_000
  return {
    store,
    backend,
    service: new CursorAccountService(store, backend, () => tick++),
    setNative: (snapshot: CursorCredentialSnapshot | null) => {
      native = snapshot ? projectCursorCredential(snapshot) : null
    },
    getNative: () => native?.snapshot ?? null,
    getVault: () => structuredClone(vault)
  }
}
