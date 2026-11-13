import { describe, expect, it } from 'vitest'
import { resolveBaseRefSearchSelector } from './base-ref-search-selector'

describe('base ref search selectors', () => {
  it('qualifies slash-named locals even when no remote is configured', () => {
    expect(resolveBaseRefSearchSelector('refs/heads/origin/feature', 'origin/feature')).toBe(
      'refs/heads/origin/feature'
    )
    expect(resolveBaseRefSearchSelector('refs/heads/foo/bar/feature', 'foo/bar/feature')).toBe(
      'refs/heads/foo/bar/feature'
    )
    expect(resolveBaseRefSearchSelector('refs/heads/feature/local', 'feature/local')).toBe(
      'refs/heads/feature/local'
    )
    expect(resolveBaseRefSearchSelector('refs/heads/main', 'main')).toBe('main')
  })
  it.each([
    ['refs/heads/feature/加', 'feature/�', 'refs/heads/feature/加'],
    ['refs/heads/feature/加', 'feature/', 'refs/heads/feature/加'],
    ['refs/heads/feature/�', 'feature/�', 'refs/heads/feature/�'],
    ['refs/heads/�', '�', '�'],
    ['refs/heads/feature/�', 'refs/heads/feature/�', 'refs/heads/feature/�'],
    ['refs/heads/feature', 'heads/feature', 'refs/heads/feature'],
    ['refs/remotes/origin/feature', 'remotes/origin/feature', 'refs/remotes/origin/feature'],
    ['refs/remotes/refs/heads/feature', 'refs/heads/feature', 'refs/remotes/refs/heads/feature'],
    ['refs/remotes/origin/feature/HEAD', 'origin/feature', 'refs/remotes/origin/feature/HEAD'],
    [
      'refs/heads/refs/remotes/origin/feature',
      'refs/remotes/origin/feature',
      'refs/heads/refs/remotes/origin/feature'
    ],
    [
      'refs/remotes/refs/remotes/feature',
      'refs/remotes/feature',
      'refs/remotes/refs/remotes/feature'
    ],
    ['refs/remotes/origin/feature/HEAD', 'origin/fea', 'refs/remotes/origin/feature/HEAD']
  ])('preserves the identity of %s with short field %s', (full, short, expected) => {
    expect(resolveBaseRefSearchSelector(full, short)).toBe(expected)
  })
})
