import { describe, expect, it } from 'vitest'
import {
  buildPlaneWorkspace,
  defaultPlaneAppUrl,
  detectPlaneDeployment,
  getPlaneWorkspaceId,
  normalizePlaneBaseUrl,
  planeWorkspaceToViewer,
  toPlaneViewer
} from './workspace-identity'

describe('normalizePlaneBaseUrl', () => {
  it.each([
    ['api.plane.so', 'https://api.plane.so'],
    ['https://api.plane.so/', 'https://api.plane.so'],
    ['https://api.plane.so/api/v1', 'https://api.plane.so'],
    ['https://api.plane.so/api/v1/', 'https://api.plane.so'],
    ['https://plane.internal:8443/tools/?a=b#c', 'https://plane.internal:8443/tools']
  ])('normalizes %s', (input, expected) => {
    expect(normalizePlaneBaseUrl(input)).toBe(expected)
  })
})

describe('base url schemes', () => {
  it.each(['ftp://plane.internal', 'file:///etc/passwd', 'javascript://plane.so'])(
    'rejects %s, which would leak the api token or hand net.fetch an arbitrary origin',
    (value) => {
      expect(() => normalizePlaneBaseUrl(value)).toThrow('Plane URL must use http or https.')
    }
  )

  it('rejects a url carrying credentials, which status would hand to any client', () => {
    // The normalized url is persisted and returned by status; a password here
    // would escape the boundary that keeps the PAT in the encrypted vault.
    expect(() => normalizePlaneBaseUrl('https://alice:pw@plane.example')).toThrow(
      'Plane URL must not contain a username or password.'
    )
    expect(() => normalizePlaneBaseUrl('https://alice@plane.example')).toThrow(
      'Plane URL must not contain a username or password.'
    )
  })

  it('still allows http for a loopback or intranet instance', () => {
    expect(normalizePlaneBaseUrl('http://plane.internal:8080')).toBe('http://plane.internal:8080')
  })
})

describe('deployment detection', () => {
  it.each([
    ['https://api.plane.so', 'cloud'],
    ['https://app.plane.so', 'cloud'],
    ['https://plane.internal', 'self-hosted'],
    ['https://notplane.so', 'self-hosted']
  ])('classifies %s as %s', (baseUrl, expected) => {
    expect(detectPlaneDeployment(baseUrl)).toBe(expected)
  })

  it('splits cloud api and app hosts but keeps self-hosted on one origin', () => {
    expect(defaultPlaneAppUrl('https://api.plane.so')).toBe('https://app.plane.so')
    expect(defaultPlaneAppUrl('https://plane.internal/tools/')).toBe('https://plane.internal/tools')
  })
})

describe('getPlaneWorkspaceId', () => {
  it('is stable across equivalent base urls and slug casing', () => {
    const canonical = getPlaneWorkspaceId('https://api.plane.so', 'acme')
    expect(getPlaneWorkspaceId('https://api.plane.so/api/v1/', ' ACME ')).toBe(canonical)
  })

  it('separates different workspaces and different hosts', () => {
    const acme = getPlaneWorkspaceId('https://api.plane.so', 'acme')
    expect(getPlaneWorkspaceId('https://api.plane.so', 'other')).not.toBe(acme)
    expect(getPlaneWorkspaceId('https://plane.internal', 'acme')).not.toBe(acme)
  })
})

describe('buildPlaneWorkspace', () => {
  it('fills the app url and deployment for cloud', () => {
    expect(buildPlaneWorkspace({ baseUrl: 'api.plane.so', slug: ' acme ' })).toEqual({
      id: getPlaneWorkspaceId('https://api.plane.so', 'acme'),
      slug: 'acme',
      // Plane exposes no workspace-list endpoint, so the slug is the best name.
      name: 'acme',
      baseUrl: 'https://api.plane.so',
      appUrl: 'https://app.plane.so',
      deployment: 'cloud'
    })
  })

  it('honours an explicit app url for a self-hosted instance', () => {
    expect(
      buildPlaneWorkspace({
        baseUrl: 'https://plane.internal',
        slug: 'acme',
        appUrl: 'https://plane.internal/app/'
      })
    ).toMatchObject({ appUrl: 'https://plane.internal/app', deployment: 'self-hosted' })
  })
})

describe('toPlaneViewer', () => {
  it('prefers display_name, then a composed full name, then email', () => {
    expect(toPlaneViewer({ id: 'u1', display_name: 'Ada L', email: 'ada@example.com' })).toEqual({
      id: 'u1',
      displayName: 'Ada L',
      email: 'ada@example.com'
    })
    expect(
      toPlaneViewer({ id: 'u1', first_name: 'Ada', last_name: 'Lovelace', email: 'a@e.com' })
    ).toMatchObject({ displayName: 'Ada Lovelace' })
  })

  it('falls back to email when no name field is populated', () => {
    // Regression: an empty composed name is '' which is not nullish, so a naive
    // ?? chain would return '' instead of the email.
    expect(toPlaneViewer({ id: 'u1', email: 'ada@example.com' })).toMatchObject({
      displayName: 'ada@example.com'
    })
  })

  it('carries an avatar from either field name', () => {
    expect(toPlaneViewer({ id: 'u1', avatar: 'https://img/a.png' })).toMatchObject({
      avatarUrl: 'https://img/a.png'
    })
    expect(toPlaneViewer({ id: 'u1' }).avatarUrl).toBeUndefined()
  })
})

describe('planeWorkspaceToViewer', () => {
  it('returns null without a workspace', () => {
    expect(planeWorkspaceToViewer(null)).toBeNull()
  })
})
