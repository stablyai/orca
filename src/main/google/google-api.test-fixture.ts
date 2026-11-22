// A Google account connected on a temp home, and a fake Google that answers by URL, for tests of
// the Google tools. Answers are recorded shapes from Google's API reference.
import { mkdtempSync, rmSync } from 'node:fs'
import * as realOs from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { GOOGLE_SERVICE_CHOICES, googleSignInScopes } from '../../shared/google/google-scopes'

export const NOW = Date.parse('2026-11-03T19:05:00Z')

export type FakeRoute = (url: URL, init?: RequestInit) => Response | Promise<Response> | null

export const googleJson = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Answers each request with the first route that knows it; anything else is a test bug. */
export function fakeGoogle(routes: FakeRoute[]) {
  const calls: URL[] = []
  const http: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push(url)
    for (const route of routes) {
      const answer = await route(url, init)
      if (answer) {
        return answer
      }
    }
    throw new Error(`no fake Google answer for ${url.toString()}`)
  }
  return { http, calls }
}

/** Fresh modules on a temp home with `emails` connected; call `cleanup` after. */
export async function connectedGoogle(emails: string[] = ['ada@acme.dev']) {
  const home = mkdtempSync(join(realOs.tmpdir(), 'orca-google-tools-'))
  vi.resetModules()
  const { setSecretStore } = await import('../../shared/secure-storage/secret-store')
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${value}`),
    decryptString: (value) => value.toString('utf-8').replace(/^sealed:/, ''),
    describeProtectionGap: () => null
  })
  vi.doMock('node:os', () => ({ ...realOs, homedir: () => home }))
  vi.doMock('os', () => ({ ...realOs, homedir: () => home }))
  const store = await import('./google-credential-store')
  for (const email of emails) {
    await store.saveGoogleAccount({
      email,
      client: { clientId: 'c.apps.googleusercontent.com', clientSecret: 's' },
      projectId: 'acme-orca',
      refreshToken: 'rt-1',
      accessToken: 'at-1',
      expiresAt: NOW + 3_600_000,
      grantedScopes: googleSignInScopes(GOOGLE_SERVICE_CHOICES),
      choices: [...GOOGLE_SERVICE_CHOICES],
      status: 'connected',
      services: [],
      connectedAt: NOW
    })
  }
  return {
    home,
    client: await import('./google-api-client'),
    cleanup: () => rmSync(home, { recursive: true, force: true })
  }
}
