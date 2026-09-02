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

  // Why (STA-4300 §4.1): this is the ONLY property that distinguishes two passes from one. A
  // per-row guard emits the readable sibling before it can know the family will be skipped, so it
  // passes unreadable-first and fails readable-first. Both orders must produce the same plan.
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
    // Why (§2b): importedDomainScopes expands an imported domain into its descendant roots, so a
    // readable cookie on mixed.example pulls sub.mixed.example into the removal scope. Preserving
    // only the exact skipped domain would still erase the sibling's live session.
    const plan = planImportWrites([
      cookie('deep.sub.mixed.example', 'unreadable', UNREADABLE),
      cookie('.mixed.example', 'apex', READABLE),
      cookie('other.mixed.example', 'cousin', READABLE)
    ])

    expect(plan.writes).toHaveLength(0)
    expect([...plan.skippedFamilies]).toEqual(['mixed.example'])
  })

  it('does not suppress a different family that merely shares a public suffix', () => {
    const plan = planImportWrites([
      cookie('.skipped.example', 'unreadable', UNREADABLE),
      cookie('.kept.example', 'kept', READABLE)
    ])

    expect(names(plan.writes)).toEqual(['kept'])
    expect([...plan.skippedFamilies]).toEqual(['skipped.example'])
  })

  it('flags a skip whose family cannot be named so the caller can refuse before mutating', () => {
    // Why (§4.3c): a family we cannot name is one we cannot exclude from the removal plan, and
    // clearing a family we cannot protect is exactly the P0. Refusal is the caller's job; the
    // planner's job is to make the condition impossible to miss.
    const plan = planImportWrites([cookie('com', 'bare-suffix', UNREADABLE)])

    expect(plan.hasUnrepresentableSkip).toBe(true)
    expect(plan.writes).toHaveLength(0)
  })

  it('leaves hasUnrepresentableSkip false when every skipped family is nameable', () => {
    const plan = planImportWrites([cookie('.mixed.example', 'unreadable', UNREADABLE)])

    expect(plan.hasUnrepresentableSkip).toBe(false)
    expect([...plan.skippedFamilies]).toEqual(['mixed.example'])
  })

  it('counts every suppressed cookie as skipped so the summary still adds up', () => {
    const rows = [
      cookie('.mixed.example', 'readable-sibling', READABLE),
      cookie('sub.mixed.example', 'unreadable', UNREADABLE),
      cookie('.other.example', 'unrelated', READABLE)
    ]

    const plan = planImportWrites(rows)

    // totalCookies === importedCookies + skippedCookies, as an identity rather than a field.
    expect(plan.writes.length + plan.skips.length).toBe(rows.length)
  })
})
