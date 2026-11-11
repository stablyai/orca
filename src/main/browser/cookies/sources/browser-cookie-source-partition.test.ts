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

  it('refuses a partitioned row whose schema has no cross-site-ancestor column', () => {
    const result = readChromiumRowPartition(
      { top_frame_site_key: 'https://top.example' },
      new Set(['host_key', 'name', 'top_frame_site_key'])
    )

    expect(result.status).toBe('unreadable')
    expect(result).toHaveProperty('reason', expect.stringContaining('cross-site-ancestor'))
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

  it('refuses a partitionKey missing the cross-site-ancestor bit', () => {
    expect(readJsonCookiePartition({ topLevelSite: 'https://top.example' }).status).toBe(
      'unreadable'
    )
  })
})

describe('readFirefoxRowPartition', () => {
  // Firefox storage isolation does not imply a server-declared Partitioned attribute.
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
})
