import { describe, expect, it } from 'vitest'
import { planImportWrites } from './browser-cookie-import-write'
import { summarizePartitionSkips } from './browser-cookie-partition-summary'

describe('summarizePartitionSkips', () => {
  it('omits the breakdown when nothing was skipped', () => {
    expect(summarizePartitionSkips([])).toBeUndefined()
  })

  it('separates unreadable rows from family-preserved siblings without publishing secrets', () => {
    const plan = planImportWrites([
      {
        domain: '.example.com',
        partition: { status: 'unpartitioned' as const },
        name: 'secret-name',
        value: 'secret-value'
      },
      {
        domain: 'sub.example.com',
        partition: { status: 'unreadable' as const, reason: 'partition key was opaque' },
        name: 'auth-name',
        value: 'auth-value'
      },
      {
        domain: '.other.com',
        partition: { status: 'unpartitioned' as const },
        name: 'other',
        value: 'other-secret'
      }
    ])
    const summary = summarizePartitionSkips(plan.skips)
    expect(summary).toEqual({
      unreadableCookies: 1,
      preservedRelatedCookies: 1,
      domains: ['example.com', 'sub.example.com'],
      reasons: [{ reason: 'partition key was opaque', count: 1 }]
    })
    expect(plan.writes.map((cookie) => cookie.domain)).toEqual(['.other.com'])
    expect(JSON.stringify(summary)).not.toMatch(
      /secret-name|secret-value|auth-name|auth-value|other-secret/
    )
  })

  it('counts repeated source reasons independently of sibling suppression', () => {
    const plan = planImportWrites([
      {
        domain: '.a.com',
        partition: { status: 'unreadable' as const, reason: 'missing ancestor' }
      },
      { domain: '.b.com', partition: { status: 'unreadable' as const, reason: 'missing ancestor' } }
    ])
    expect(summarizePartitionSkips(plan.skips)).toMatchObject({
      unreadableCookies: 2,
      preservedRelatedCookies: 0,
      reasons: [{ reason: 'missing ancestor', count: 2 }]
    })
  })
})
