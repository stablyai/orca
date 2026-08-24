import { describe, expect, it } from 'vitest'
import type { Cookie } from 'electron'
import {
  identitiesFromClearCookies,
  type CookieClearIdentity,
  type CookieClearSession
} from './browser-cookie-import-clear'
import { cookieRemovalUrl, normalizeCookieDomain } from './browser-cookie-import-policy'
import { removeNonTransplantableCookies } from './browser-google-cookie-clear'

function cookie(domain: string, name: string, path = '/', secure = true): Cookie {
  return {
    domain,
    name,
    path,
    secure,
    sameSite: 'unspecified',
    value: `${name}-value`
  }
}

function createJarSession(initial: Cookie[]) {
  let jar = [...initial]
  const removed: { url: string; name: string }[] = []
  const session: CookieClearSession & {
    namesByDomain: () => string[]
    removed: () => { url: string; name: string }[]
    add: (entry: Cookie) => void
  } = {
    cookies: {
      get: async () => [...jar],
      remove: async (url, name) => {
        removed.push({ url, name })
        jar = jar.filter((entry) => {
          const domain = entry.domain ? normalizeCookieDomain(entry.domain) : null
          if (!domain) {
            return true
          }
          return cookieRemovalUrl(entry, domain) !== url || entry.name !== name
        })
      }
    },
    snapshotClearIdentities: async (items) => identitiesFromClearCookies(items),
    restoreClearIdentities: async (identities: readonly CookieClearIdentity[]) => {
      for (const identity of identities) {
        if (jar.some((entry) => entry.name === identity.name && entry.domain === identity.domain)) {
          continue
        }
        jar.push(
          cookie(identity.domain ?? '', identity.name, identity.path, identity.secure === true)
        )
      }
    },
    namesByDomain: () => jar.map((entry) => `${entry.domain}:${entry.name}`).sort(),
    removed: () => [...removed],
    add: (entry) => {
      jar.push(entry)
    }
  }
  return session
}

function seedMixedJar(): Cookie[] {
  return [
    cookie('.google.com', 'SID'),
    cookie('accounts.google.com', '__Secure-1PSID'),
    cookie('.mail.google.com', 'OSID'),
    cookie('.example.com', 'session'),
    cookie('.youtube.com', 'SID'),
    cookie('github.com', 'user', '/', false),
    cookie('google.com.evil.example', 'SID')
  ]
}

describe('STA-4398 Google-family cookie clear', () => {
  it('removes google.com-family cookies and leaves every other family intact', async () => {
    const jar = createJarSession(seedMixedJar())

    await removeNonTransplantableCookies(jar)

    expect(jar.namesByDomain()).toEqual([
      '.example.com:session',
      '.youtube.com:SID',
      'github.com:user',
      'google.com.evil.example:SID'
    ])
  })

  it('can clear Google cookies more than once after they return', async () => {
    const jar = createJarSession(seedMixedJar())

    await removeNonTransplantableCookies(jar)
    expect(jar.namesByDomain()).not.toContain('.google.com:SID')

    jar.add(cookie('.google.com', 'SID'))
    jar.add(cookie('accounts.google.com', 'SAPISID'))
    await removeNonTransplantableCookies(jar)

    expect(jar.namesByDomain()).toEqual([
      '.example.com:session',
      '.youtube.com:SID',
      'github.com:user',
      'google.com.evil.example:SID'
    ])
  })

  it('is a no-op success when the jar has no Google cookies', async () => {
    const jar = createJarSession([cookie('.example.com', 'session'), cookie('.youtube.com', 'SID')])

    await expect(removeNonTransplantableCookies(jar)).resolves.toBeUndefined()
    expect(jar.namesByDomain()).toEqual(['.example.com:session', '.youtube.com:SID'])
    expect(jar.removed()).toEqual([])
  })
})
