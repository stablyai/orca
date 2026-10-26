import { describe, expect, it } from 'vitest'
import { planImportWrites, type SourceCookieToWrite } from './browser-cookie-import-write'

function cookie(domain: string, name: string, partition: SourceCookieToWrite['partition']) {
  const host = domain.startsWith('.') ? domain.slice(1) : domain
  return {
    url: `https://${host}/`,
    domain,
    name,
    value: `${name}-value`,
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'no_restriction',
    expirationDate: undefined,
    partition
  } satisfies SourceCookieToWrite
}

const READABLE = { status: 'unpartitioned' } as const
const UNREADABLE = {
  status: 'unreadable',
  reason: 'schema has no has_cross_site_ancestor'
} as const

const names = (cookies: readonly SourceCookieToWrite[]) => cookies.map((c) => c.name).sort()

describe('planImportWrites', () => {
  it('writes every cookie when no partition is unreadable', () => {
    const plan = planImportWrites([
      cookie('.a.example', 'a', READABLE),
      cookie('.b.example', 'b', READABLE)
    ])

    expect(names(plan.writes)).toEqual(['a', 'b'])
    expect(plan.skips).toHaveLength(0)
    expect(plan.skippedFamilies.size).toBe(0)
  })

  it('skips the whole registrable family, not just the unreadable cookie', () => {
    const plan = planImportWrites([
      cookie('.mixed.example', 'readable-sibling', READABLE),
      cookie('sub.mixed.example', 'unreadable', UNREADABLE),
      cookie('.other.example', 'unrelated', READABLE)
    ])

    expect(names(plan.writes)).toEqual(['unrelated'])
    expect(names(plan.skips.map((s) => s.cookie))).toEqual(['readable-sibling', 'unreadable'])
    expect([...plan.skippedFamilies]).toEqual(['mixed.example'])
  })

  // Both input orders must suppress the whole family, including earlier readable rows.
  it.each([
    [
      'readable before unreadable',
      [
        cookie('.mixed.example', 'readable-sibling', READABLE),
        cookie('sub.mixed.example', 'unreadable', UNREADABLE)
      ]
    ],
    [
      'unreadable before readable',
      [
        cookie('sub.mixed.example', 'unreadable', UNREADABLE),
        cookie('.mixed.example', 'readable-sibling', READABLE)
      ]
    ]
  ])('suppresses the family regardless of source row order (%s)', (_label, rows) => {
    const plan = planImportWrites(rows)

    expect(plan.writes).toHaveLength(0)
    expect(names(plan.skips.map((s) => s.cookie))).toEqual(['readable-sibling', 'unreadable'])
    expect([...plan.skippedFamilies]).toEqual(['mixed.example'])
  })

  it('closes the family at the registrable boundary, not the exact domain', () => {
    const plan = planImportWrites([
      cookie('deep.sub.mixed.example', 'unreadable', UNREADABLE),
      cookie('.mixed.example', 'apex', READABLE),
      cookie('other.mixed.example', 'cousin', READABLE)
    ])

    expect(plan.writes).toHaveLength(0)
    expect([...plan.skippedFamilies]).toEqual(['mixed.example'])
  })

  it('flags a skip whose family cannot be named so the caller can refuse before mutating', () => {
    const plan = planImportWrites([cookie('com', 'bare-suffix', UNREADABLE)])

    expect(plan.hasUnrepresentableSkip).toBe(true)
    expect(plan.writes).toHaveLength(0)
  })

  it('leaves hasUnrepresentableSkip false when every skipped family is nameable', () => {
    const plan = planImportWrites([cookie('.mixed.example', 'unreadable', UNREADABLE)])

    expect(plan.hasUnrepresentableSkip).toBe(false)
    expect([...plan.skippedFamilies]).toEqual(['mixed.example'])
  })
})
