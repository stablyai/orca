import { describe, expect, it } from 'vitest'
import { matchTrailingDirListingSize } from './terminal-dir-listing-size-dim'

describe('matchTrailingDirListingSize', () => {
  it('matches agent-style trailing size tokens', () => {
    expect(matchTrailingDirListingSize('README.md  1.4K')).toEqual({
      start: 11,
      end: 15,
      token: '1.4K'
    })
    expect(matchTrailingDirListingSize('src/index.ts  738B')).toEqual({
      start: 14,
      end: 18,
      token: '738B'
    })
    expect(matchTrailingDirListingSize('bundle.js  45.9M')).toEqual({
      start: 11,
      end: 16,
      token: '45.9M'
    })
    expect(matchTrailingDirListingSize('disk.img  2G')).toEqual({
      start: 10,
      end: 12,
      token: '2G'
    })
    expect(matchTrailingDirListingSize('cache  1.2KB')).toEqual({
      start: 7,
      end: 12,
      token: '1.2KB'
    })
  })

  it('ignores prose and non-listing shapes', () => {
    expect(matchTrailingDirListingSize('use a 4K display')).toBeNull()
    expect(matchTrailingDirListingSize('  1.4K')).toBeNull()
    expect(matchTrailingDirListingSize('file1.4K')).toBeNull()
    expect(matchTrailingDirListingSize('README.md')).toBeNull()
    expect(matchTrailingDirListingSize('')).toBeNull()
  })

  it('trims trailing whitespace after the token', () => {
    expect(matchTrailingDirListingSize('a.ts  12B  ')).toEqual({
      start: 6,
      end: 9,
      token: '12B'
    })
  })
})
