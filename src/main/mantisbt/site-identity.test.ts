import { describe, expect, it } from 'vitest'
import { getSiteId, normalizeMantisBTSiteUrl, siteToViewer, toViewer } from './site-identity'

describe('normalizeMantisBTSiteUrl', () => {
  it('defaults to https and strips trailing slash, query, and hash', () => {
    expect(normalizeMantisBTSiteUrl('mantisbt.example.com/')).toBe('https://mantisbt.example.com')
    expect(normalizeMantisBTSiteUrl('https://mantisbt.example.com/base/?x=1#y')).toBe(
      'https://mantisbt.example.com/base'
    )
  })

  it('rejects an explicit http:// site URL', () => {
    expect(() => normalizeMantisBTSiteUrl('http://mantisbt.example.com')).toThrow(/HTTPS/)
  })

  it('allows http:// only for loopback hosts', () => {
    expect(normalizeMantisBTSiteUrl('http://localhost:8080')).toBe('http://localhost:8080')
    expect(normalizeMantisBTSiteUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })
})

describe('getSiteId', () => {
  it('is stable for the same inputs and differs across users on the same site', () => {
    const a = getSiteId('https://mantisbt.example.com', '42')
    const b = getSiteId('https://mantisbt.example.com', '42')
    const c = getSiteId('https://mantisbt.example.com', '99')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })
})

describe('toViewer', () => {
  // Why: MantisBT's GET /api/rest/users/me (rest_user_get_me -> UserGetCommand
  // with return_as_users: false) returns a flat user object on a stock
  // install — this is the shape a real server actually returns.
  it('reads a flat user object, the real /users/me shape', () => {
    expect(
      toViewer({ id: 42, name: 'wquintal', real_name: 'William', email: 'william@example.com' })
    ).toEqual({ id: '42', displayName: 'William', email: 'william@example.com' })
  })

  it('reads a { user: {...} } envelope, the /users/{id} shape', () => {
    expect(toViewer({ user: { id: 7, name: 'ada', real_name: 'Ada' } })).toEqual({
      id: '7',
      displayName: 'Ada',
      email: undefined
    })
  })

  it('reads a { users: [...] } envelope, the /users/username/{username} shape', () => {
    expect(toViewer({ users: [{ id: 8, name: 'grace' }] })).toEqual({
      id: '8',
      displayName: 'grace',
      email: undefined
    })
  })

  it('falls back to the numeric id as displayName when no name is present', () => {
    expect(toViewer({ id: 3 })).toEqual({ id: '3', displayName: '3', email: undefined })
  })
})

describe('siteToViewer', () => {
  it('maps a stored site to a viewer without a network call', () => {
    expect(
      siteToViewer({
        id: 'site-1',
        siteUrl: 'https://mantisbt.example.com',
        userId: '42',
        displayName: 'William',
        authScheme: 'bearer',
        usePhpIndexPath: false
      })
    ).toEqual({ id: '42', displayName: 'William' })
  })

  it('returns null for no site', () => {
    expect(siteToViewer(null)).toBeNull()
  })
})
