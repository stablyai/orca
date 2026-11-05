import { describe, expect, it } from 'vitest'
import { validateManifestLinkRoutes } from './plugin-link-route-suffix-policy'

const ok = (hostname: string) => validateManifestLinkRoutes([{ hostname }])

describe('validateManifestLinkRoutes', () => {
  it.each(['*.example.com', 'app.example.com', '*-loopspark.test', '*.myapp.co'])(
    'accepts %s',
    (hostname) => {
      expect(ok(hostname)).toBeNull()
    }
  )

  it.each(['*.com', '*.co.uk', '*.github.io', '*.s3.amazonaws.com'])(
    'rejects a wildcard over the public suffix %s',
    (hostname) => {
      expect(ok(hostname)).not.toBeNull()
    }
  )

  it('still rejects a bare reserved tld, which is as broad as *.com within a dev namespace', () => {
    expect(ok('*.test')).not.toBeNull()
    expect(ok('*.localhost')).not.toBeNull()
  })

  it('exempts a reserved tld under a named domain, where tldts reports no registrable domain', () => {
    // tldts returns domain: null for `myapp.test`, so the suffix check must not treat that as a
    // violation or the motivating dev-hostname case would be rejected.
    expect(ok('*.myapp.test')).toBeNull()
  })

  it('reports a hostname the shared shape rules already reject', () => {
    expect(ok('*e.com')).toBe('invalid link route hostname "*e.com"')
  })

  it('checks every route, not just the first', () => {
    expect(
      validateManifestLinkRoutes([{ hostname: 'app.example.com' }, { hostname: '*.co.uk' }])
    ).not.toBeNull()
  })
})
