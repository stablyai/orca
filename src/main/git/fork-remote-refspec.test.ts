import { describe, expect, it } from 'vitest'
import {
  compatibleFetchMapping,
  resolveFetchTrackingRef,
  sourceRefsForTarget
} from '../../shared/git-branch-cleanup-fetch'

describe('fetch mapping domain and native inverse', () => {
  const proposed = '+refs/heads/topic*:refs/remotes/fork/topic*'
  it.each([
    ['+refs/heads/topic-old:refs/remotes/fork/topic-old', true],
    ['+refs/heads/secret:refs/remotes/fork/topic-other', false],
    ['+refs/heads/*:refs/remotes/fork/*', true],
    ['+refs/heads/other*:refs/remotes/fork/topic*', false],
    ['+refs/heads/*-old:refs/remotes/fork/*-new', false],
    ['+refs/heads/main:refs/remotes/fork/main', true],
    ['not-a-mapping', true],
    ['+refs/heads/topic*:refs/remotes/fork/topic', false]
  ])('proves the whole intersection with %s', (existing, compatible) => {
    expect(compatibleFetchMapping(proposed, existing)).toBe(compatible)
  })
  it.each(['refs/private/*', 'refs/private/*-cache'])(
    'retains custom destination %s',
    (destination) => {
      const specs = [`+refs/heads/*:${destination}`]
      const target = resolveFetchTrackingRef(specs, 'refs/heads/topic')!
      expect(sourceRefsForTarget(specs, target)).toEqual(['refs/heads/topic'])
      expect(
        resolveFetchTrackingRef([...specs, '^refs/heads/topic'], 'refs/heads/topic')
      ).toBeUndefined()
    }
  )
})
