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
  it.each([false, true])('keeps readable siblings regardless of row order (%s)', (reverse) => {
    const rows = [
      cookie('.mixed.example', 'readable', READABLE),
      cookie('sub.mixed.example', 'unreadable', UNREADABLE),
      cookie('.other.example', 'unrelated', READABLE)
    ]
    const plan = planImportWrites(reverse ? rows.toReversed() : rows)
    expect(names(plan.writes)).toEqual(['readable', 'unrelated'])
    expect(names(plan.skips.map((skip) => skip.cookie))).toEqual(['unreadable'])
  })

  it('counts an unreadable row even when it has no registrable family', () => {
    const plan = planImportWrites([cookie('com', 'unreadable', UNREADABLE)])
    expect(plan.writes).toEqual([])
    expect(plan.skips).toHaveLength(1)
  })
})
