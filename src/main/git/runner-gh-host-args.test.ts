import { describe, expect, it } from 'vitest'

import { applyGhHostToArgs } from './runner'

describe('applyGhHostToArgs', () => {
  it('returns args unchanged when no host is given', () => {
    const args = ['api', 'repos/a/b/pulls']
    expect(applyGhHostToArgs(args)).toBe(args)
    expect(applyGhHostToArgs(['pr', 'list', '--repo', 'a/b'])).toEqual([
      'pr',
      'list',
      '--repo',
      'a/b'
    ])
  })

  it('injects --hostname right after `api` for any host', () => {
    expect(applyGhHostToArgs(['api', 'rate_limit'], 'github.com')).toEqual([
      'api',
      '--hostname',
      'github.com',
      'rate_limit'
    ])
    expect(applyGhHostToArgs(['api', 'repos/a/b/pulls'], 'github.acme-corp.com')).toEqual([
      'api',
      '--hostname',
      'github.acme-corp.com',
      'repos/a/b/pulls'
    ])
  })

  it('does not double-inject when --hostname is already present', () => {
    expect(
      applyGhHostToArgs(['api', '--hostname', 'github.com', 'rate_limit'], 'github.acme-corp.com')
    ).toEqual(['api', '--hostname', 'github.com', 'rate_limit'])
    expect(
      applyGhHostToArgs(['api', '--hostname=github.com', 'rate_limit'], 'github.acme-corp.com')
    ).toEqual(['api', '--hostname=github.com', 'rate_limit'])
  })

  it('qualifies bare owner/repo in --repo / -R for a GHES host', () => {
    expect(applyGhHostToArgs(['pr', 'list', '--repo', 'a/b'], 'github.acme-corp.com')).toEqual([
      'pr',
      'list',
      '--repo',
      'github.acme-corp.com/a/b'
    ])
    expect(applyGhHostToArgs(['pr', 'list', '-R', 'a/b'], 'github.acme-corp.com')).toEqual([
      'pr',
      'list',
      '-R',
      'github.acme-corp.com/a/b'
    ])
  })

  it('qualifies the inline --repo= form for a GHES host', () => {
    expect(applyGhHostToArgs(['pr', 'list', '--repo=a/b'], 'github.acme-corp.com')).toEqual([
      'pr',
      'list',
      '--repo=github.acme-corp.com/a/b'
    ])
  })

  it('leaves combined -R short forms untouched (indistinguishable from free-text values)', () => {
    expect(applyGhHostToArgs(['pr', 'list', '-R=a/b'], 'github.acme-corp.com')).toEqual([
      'pr',
      'list',
      '-R=a/b'
    ])
    expect(applyGhHostToArgs(['pr', 'list', '-Ra/b'], 'github.acme-corp.com')).toEqual([
      'pr',
      'list',
      '-Ra/b'
    ])
  })

  it('does not rewrite free-text flag values that merely start with -R', () => {
    expect(
      applyGhHostToArgs(
        ['pr', 'edit', '7', '--title', '-Refactor foo/bar', '--repo', 'a/b'],
        'github.acme-corp.com'
      )
    ).toEqual([
      'pr',
      'edit',
      '7',
      '--title',
      '-Refactor foo/bar',
      '--repo',
      'github.acme-corp.com/a/b'
    ])
  })

  it('qualifies --repo for the github.com host so GH_HOST cannot redirect it', () => {
    expect(applyGhHostToArgs(['pr', 'list', '--repo', 'a/b'], 'github.com')).toEqual([
      'pr',
      'list',
      '--repo',
      'github.com/a/b'
    ])
    expect(applyGhHostToArgs(['pr', 'list', '--repo', 'a/b'], 'GitHub.com')).toEqual([
      'pr',
      'list',
      '--repo',
      'GitHub.com/a/b'
    ])
  })

  it('passes through URL and already-qualified 3-part --repo values', () => {
    expect(
      applyGhHostToArgs(
        ['pr', 'list', '--repo', 'https://github.acme-corp.com/a/b'],
        'github.acme-corp.com'
      )
    ).toEqual(['pr', 'list', '--repo', 'https://github.acme-corp.com/a/b'])
    expect(
      applyGhHostToArgs(
        ['pr', 'list', '--repo', 'github.acme-corp.com/a/b'],
        'github.acme-corp.com'
      )
    ).toEqual(['pr', 'list', '--repo', 'github.acme-corp.com/a/b'])
    expect(
      applyGhHostToArgs(
        ['pr', 'list', '-R', 'https://github.acme-corp.com/a/b'],
        'github.acme-corp.com'
      )
    ).toEqual(['pr', 'list', '-R', 'https://github.acme-corp.com/a/b'])
  })

  it('injects --hostname and qualifies --repo together for GHES api calls', () => {
    expect(
      applyGhHostToArgs(['api', 'repos/a/b/pulls', '--repo', 'a/b'], 'github.acme-corp.com')
    ).toEqual([
      'api',
      '--hostname',
      'github.acme-corp.com',
      'repos/a/b/pulls',
      '--repo',
      'github.acme-corp.com/a/b'
    ])
  })
})
