import { describe, expect, it } from 'vitest'
import {
  readChromiumRowPartition,
  readFirefoxRowPartition,
  readJsonCookiePartition
} from './browser-cookie-source-partition'

const MODERN_COLUMNS = new Set([
  'host_key',
  'name',
  'top_frame_site_key',
  'has_cross_site_ancestor'
])

describe('readChromiumRowPartition', () => {
  it('reads a partitioned row as both halves of the partition key', () => {
    expect(
      readChromiumRowPartition(
        { top_frame_site_key: 'https://top.example', has_cross_site_ancestor: 1n },
        MODERN_COLUMNS
      )
    ).toEqual({
      status: 'partitioned',
      partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
    })
  })

  it('carries a false cross-site-ancestor rather than defaulting it to true', () => {
    expect(
      readChromiumRowPartition(
        { top_frame_site_key: 'https://top.example', has_cross_site_ancestor: 0n },
        MODERN_COLUMNS
      )
    ).toEqual({
      status: 'partitioned',
      partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: false }
    })
  })

  it('reads an empty partition site as unpartitioned', () => {
    expect(
      readChromiumRowPartition(
        { top_frame_site_key: '', has_cross_site_ancestor: 0n },
        MODERN_COLUMNS
      )
    ).toEqual({ status: 'unpartitioned' })
  })

  // Why: a schema predating cookie partitioning genuinely has no partitioned rows, so importing
  // every one of its cookies unpartitioned is faithful rather than lossy.
  it('reads a schema without the partition column as unpartitioned', () => {
    expect(readChromiumRowPartition({ name: 'sid' }, new Set(['host_key', 'name']))).toEqual({
      status: 'unpartitioned'
    })
  })

  // Why (STA-4300): the ancestor bit selects which partition the cookie lands in. Guessing it files
  // the cookie under a partition the site never reads — indistinguishable from losing it.
  it('refuses a partitioned row whose schema has no cross-site-ancestor column', () => {
    const result = readChromiumRowPartition(
      { top_frame_site_key: 'https://top.example' },
      new Set(['host_key', 'name', 'top_frame_site_key'])
    )

    expect(result.status).toBe('unreadable')
    expect(result).toHaveProperty('reason', expect.stringContaining('cross-site-ancestor'))
  })

  it('refuses a partitioned row whose ancestor flag is not an integer', () => {
    expect(
      readChromiumRowPartition(
        { top_frame_site_key: 'https://top.example', has_cross_site_ancestor: null },
        MODERN_COLUMNS
      ).status
    ).toBe('unreadable')
  })

  it.each([2n, -1n, 2, -1, 0.5])('refuses an out-of-range ancestor flag (%s)', (flag) => {
    expect(
      readChromiumRowPartition(
        { top_frame_site_key: 'https://top.example', has_cross_site_ancestor: flag },
        MODERN_COLUMNS
      ).status
    ).toBe('unreadable')
  })

  it('refuses a partition site column that is not text', () => {
    expect(
      readChromiumRowPartition(
        { top_frame_site_key: 42, has_cross_site_ancestor: 1n },
        MODERN_COLUMNS
      ).status
    ).toBe('unreadable')
  })

  it.each([null, 'not-a-site', 'ftp://top.example', 'https://top.example/path'])(
    'refuses an invalid partition site (%s)',
    (topFrameSiteKey) => {
      expect(
        readChromiumRowPartition(
          { top_frame_site_key: topFrameSiteKey, has_cross_site_ancestor: 1n },
          MODERN_COLUMNS
        ).status
      ).toBe('unreadable')
    }
  )
})

describe('readJsonCookiePartition', () => {
  // Why: every mainstream exporter omits the field for ordinary cookies, so absence has to mean
  // unpartitioned or whole exports would be rejected.
  it('reads an absent partitionKey as unpartitioned', () => {
    expect(readJsonCookiePartition(undefined)).toEqual({ status: 'unpartitioned' })
  })

  it('refuses an opaque partition key even when its key object is absent or populated', () => {
    expect(readJsonCookiePartition(undefined, true)).toEqual({
      status: 'unreadable',
      reason: 'partition key was opaque'
    })
    expect(
      readJsonCookiePartition(
        { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true },
        true
      ).status
    ).toBe('unreadable')
  })

  it('accepts the explicit non-opaque CDP shape and rejects a malformed opaque flag', () => {
    expect(readJsonCookiePartition(undefined, false)).toEqual({ status: 'unpartitioned' })
    expect(readJsonCookiePartition(undefined, 'false').status).toBe('unreadable')
  })

  it.each([null, ''])('refuses a present but empty partitionKey (%s)', (partitionKey) => {
    expect(readJsonCookiePartition(partitionKey).status).toBe('unreadable')
  })

  it('reads a complete partitionKey object', () => {
    expect(
      readJsonCookiePartition({ topLevelSite: 'https://top.example', hasCrossSiteAncestor: true })
    ).toEqual({
      status: 'partitioned',
      partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
    })
  })

  // Why: exporters that emit only topLevelSite carry no ancestor bit. Skipping is reported; a
  // guessed bit would be a silent misfile.
  it('refuses a partitionKey missing the cross-site-ancestor bit', () => {
    expect(readJsonCookiePartition({ topLevelSite: 'https://top.example' }).status).toBe(
      'unreadable'
    )
  })

  it('refuses the legacy string partitionKey form', () => {
    expect(readJsonCookiePartition('https://top.example').status).toBe('unreadable')
  })

  it('refuses a partitionKey with a non-boolean ancestor bit', () => {
    expect(
      readJsonCookiePartition({ topLevelSite: 'https://top.example', hasCrossSiteAncestor: 'yes' })
        .status
    ).toBe('unreadable')
  })

  it('refuses an array or empty-site partitionKey', () => {
    expect(readJsonCookiePartition([]).status).toBe('unreadable')
    expect(readJsonCookiePartition({ topLevelSite: '', hasCrossSiteAncestor: true }).status).toBe(
      'unreadable'
    )
  })

  it.each(['not-a-site', 'ftp://top.example', 'https://top.example/path'])(
    'refuses an invalid JSON partition site (%s)',
    (topLevelSite) => {
      expect(readJsonCookiePartition({ topLevelSite, hasCrossSiteAncestor: true }).status).toBe(
        'unreadable'
      )
    }
  )
})

describe('readFirefoxRowPartition', () => {
  // Why: originAttributes partitionKey components describe Firefox storage isolation, not whether
  // the server declared the cookie Partitioned.
  it('keeps a dFPI row unpartitioned even with ancestor context', () => {
    expect(
      readFirefoxRowPartition(
        {
          originAttributes: '^partitionKey=(https,example.com,f)',
          isPartitionedAttributeSet: 0n
        },
        new Set(['originAttributes', 'isPartitionedAttributeSet'])
      )
    ).toEqual({ status: 'unpartitioned' })
  })

  it('refuses a server-declared partitioned cookie', () => {
    const result = readFirefoxRowPartition(
      {
        originAttributes: '^partitionKey=(https,example.com)',
        isPartitionedAttributeSet: 1n
      },
      new Set(['originAttributes', 'isPartitionedAttributeSet'])
    )

    expect(result.status).toBe('unreadable')
    expect(result).toHaveProperty('reason', expect.stringContaining('cross-site-ancestor'))
  })

  it('reads a schema without the partitioned-attribute column as unpartitioned', () => {
    expect(
      readFirefoxRowPartition(
        { originAttributes: '^partitionKey=(https,example.com,f)' },
        new Set(['originAttributes'])
      )
    ).toEqual({ status: 'unpartitioned' })
  })

  it('refuses an invalid partitioned-attribute flag', () => {
    expect(
      readFirefoxRowPartition(
        { isPartitionedAttributeSet: null },
        new Set(['isPartitionedAttributeSet'])
      ).status
    ).toBe('unreadable')
  })
})
