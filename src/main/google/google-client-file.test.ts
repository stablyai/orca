import { describe, expect, it } from 'vitest'
import { parseGoogleClientFile } from './google-client-file'

const desktop = {
  installed: {
    client_id: '123-abc.apps.googleusercontent.com',
    project_id: 'acme-orca',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    client_secret: 'GOCSPX-secret',
    redirect_uris: ['http://localhost']
  }
}

describe('a Google client file', () => {
  it('reads a Desktop app client', () => {
    expect(parseGoogleClientFile(JSON.stringify(desktop))).toEqual({
      ok: true,
      clientId: '123-abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-secret',
      projectId: 'acme-orca'
    })
  })

  it.each([
    ['a Web app client', { web: desktop.installed }, 'This is a Web app client'],
    [
      'a service-account key',
      { type: 'service_account', private_key: 'k', client_email: 'x@y.iam.gserviceaccount.com' },
      'service-account key'
    ],
    [
      'a saved sign-in',
      { type: 'authorized_user', refresh_token: 'r', client_id: 'c', client_secret: 's' },
      'saved Google sign-in'
    ],
    ['a token export', { access_token: 'a', refresh_token: 'r' }, 'saved Google sign-in'],
    ['some other JSON', { hello: 'world' }, "isn't a Google OAuth client file"],
    [
      'a Desktop client without its secret',
      { installed: { client_id: desktop.installed.client_id } },
      'missing its client id or secret'
    ],
    [
      'a Desktop client with a foreign id',
      { installed: { ...desktop.installed, client_id: 'evil.example.com' } },
      'missing its client id or secret'
    ]
  ])('refuses %s and says what to download instead', (_label, json, words) => {
    const parsed = parseGoogleClientFile(JSON.stringify(json))
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.message).toContain(words)
    expect(parsed.ok ? '' : parsed.message).toContain('Desktop app')
  })

  it('refuses text that is not JSON', () => {
    expect(parseGoogleClientFile('not json')).toMatchObject({ ok: false })
  })
})
