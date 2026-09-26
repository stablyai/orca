import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every host-route target the host page builds, and whether its host id survives being one segment.
 *
 * `useLocalSearchParams` and the persisted host store both answer the decoded id, and the store
 * admits any non-empty string, so an id carrying `/`, `?`, `#` or whitespace stops being the single
 * segment `matchesRoutePattern` reads it as the moment it is interpolated raw. Inside the shell's
 * page that decides where a tap goes: the handoff matches the pathname against the shell's
 * `pageRoutes` before it chooses between this document and the native stack.
 *
 * A census rather than six assertions, because the failure is a habit and not a bug: each of these
 * sites was written by copying the one next to it, and the seventh will be too.
 */
const MOBILE_ROOT = join(import.meta.dirname, '..', '..')

/** The files that build a target from the host list and its row sheet. */
const HOST_PAGE_SOURCES = [
  'src/host-screen/host-screen-header.tsx',
  'src/host-screen/host-screen-overlays.tsx',
  'src/host-screen/use-host-worktree-actions.ts',
  'src/agent-history/worktree-navigation-actions.ts'
]

/**
 * The two `/h/${...}` reads that are not targets.
 *
 * Both compare against a pathname the router answers rather than building a link, so encoding them
 * would change what a comparison matches instead of what a tap opens. They are listed by the text
 * that makes them comparisons, so a line that stopped being one stops being exempt.
 */
const COMPARISONS = ['pathname === `/h/${hostId}`']

const HOST_SEGMENT = /`\/h\/\$\{([^}]*)\}/g

function hostInterpolations(source: string): string[] {
  return [...source.matchAll(HOST_SEGMENT)].map((match) => match[1] ?? '')
}

describe('every host-route target the host page builds', () => {
  it('reaches the census, so the assertion below cannot pass on an empty list', () => {
    const found = HOST_PAGE_SOURCES.flatMap((path) =>
      hostInterpolations(readFileSync(join(MOBILE_ROOT, path), 'utf8'))
    )
    expect(found.length).toBeGreaterThanOrEqual(6)
  })

  it('encodes the host id, at every site', () => {
    const raw: string[] = []
    for (const path of HOST_PAGE_SOURCES) {
      const source = readFileSync(join(MOBILE_ROOT, path), 'utf8')
      const exempt = COMPARISONS.filter((text) => source.includes(text)).length
      const unencoded = hostInterpolations(source).filter(
        (expression) => !expression.includes('encodeURIComponent')
      )
      // The comparisons are subtracted rather than matched away, so a file that lost its comparison
      // and gained a raw target does not come out even.
      if (unencoded.length > exempt) {
        raw.push(`${path}: ${unencoded.length - exempt} raw`)
      }
    }
    expect(raw).toEqual([])
  })

  it('keeps the pathname comparisons out of the count for a stated reason, not by accident', () => {
    const source = readFileSync(
      join(MOBILE_ROOT, 'src/host-screen/use-host-worktree-actions.ts'),
      'utf8'
    )
    // Present, so the exemption above is answering something real; and a comparison, so the
    // exemption is not quietly covering a target.
    expect(source).toContain(COMPARISONS[0])
  })
})
