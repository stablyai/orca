import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getMuseAccountStatus } from './status'

describe('getMuseAccountStatus', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function authFile(contents: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'muse-auth-'))
    dirs.push(dir)
    const path = join(dir, 'auth.json')
    writeFileSync(path, contents)
    return path
  }

  const signedOut = {
    signedIn: false,
    email: null,
    fullName: null,
    subscriptionActive: null,
    obtainedVia: null,
    error: null
  }

  it('reports signed out when the auth file is absent', () => {
    expect(getMuseAccountStatus(join(tmpdir(), 'muse-auth-absent', 'auth.json'))).toEqual(signedOut)
  })

  it('reports the account metadata from a Meta login session', () => {
    const status = getMuseAccountStatus(
      authFile(
        JSON.stringify({
          schema_version: 1,
          providers: {
            meta: {
              access_token: 'fake-access-token',
              user_email: 'coder@example.com',
              user_full_name: 'Code R',
              subs_active: true,
              obtained_via: 'device_flow'
            }
          }
        })
      )
    )
    expect(status).toEqual({
      signedIn: true,
      email: 'coder@example.com',
      fullName: 'Code R',
      subscriptionActive: true,
      obtainedVia: 'device_flow',
      error: null
    })
  })

  it('treats an API-key-only entry as signed in without an email', () => {
    const status = getMuseAccountStatus(
      authFile(
        JSON.stringify({
          schema_version: 1,
          providers: { meta: { api_key: 'fake-api-key' } }
        })
      )
    )
    expect(status).toEqual({ ...signedOut, signedIn: true })
  })

  it('treats a token-less entry as signed out, not a failure', () => {
    expect(
      getMuseAccountStatus(authFile(JSON.stringify({ schema_version: 1, providers: { meta: {} } })))
    ).toEqual(signedOut)
    expect(
      getMuseAccountStatus(authFile(JSON.stringify({ schema_version: 1, providers: {} })))
    ).toEqual(signedOut)
  })

  it('reports invalid files as an error', () => {
    expect(getMuseAccountStatus(authFile('not json'))).toEqual({
      ...signedOut,
      error: 'Muse auth file is invalid'
    })
    expect(getMuseAccountStatus(authFile('"just a string"'))).toEqual({
      ...signedOut,
      error: 'Muse auth file is invalid'
    })
  })
})
