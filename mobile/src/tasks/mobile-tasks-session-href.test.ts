/**
 * The href the tasks screen sends a phone to after it creates a workspace.
 *
 * The module under test is a hook with a dozen collaborators, so the property is pinned where it
 * is decided: this file asserts that no module in the tasks tree builds that href itself. A host
 * id carrying `/`, `#`, `?` or whitespace reaches the wire as a route the bridge refuses
 * (`BRIDGE_ROUTE_HREF_PATTERN`), the handoff falls through to the local router, and expo-router's
 * Unmatched paints over the page — the C1.2 class.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const TASKS_DIR = join(import.meta.dirname, '.')

function tasksSources(): string[] {
  return readdirSync(TASKS_DIR, { recursive: true, encoding: 'utf8' })
    .filter(
      (name) => /\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')
    )
    .map((name) => join(TASKS_DIR, name))
}

/**
 * Whether a source builds a `/h/...` route by hand with any segment left raw.
 *
 * Every interpolation in such a template, not just the first: checking only the leading one lets
 * `` `/h/${encodeURIComponent(hostId)}/session/${worktreeId}` `` through, and a worktree id
 * carrying `/`, `#`, `?` or whitespace breaks the href exactly as a host id does.
 */
function hasRawHostTemplate(source: string): boolean {
  return [...source.matchAll(/`\/h\/[^`]*`/g)].some((match) =>
    [...match[0].matchAll(/\$\{([^}]*)\}/g)].some(
      (interpolation) => !interpolation[1].trimStart().startsWith('encodeURIComponent(')
    )
  )
}

describe('a session href built under the tasks tree', () => {
  it('is built by the shared route helper, never interpolated raw', () => {
    const offenders = tasksSources().filter((file) =>
      hasRawHostTemplate(readFileSync(file, 'utf8'))
    )
    expect(offenders.map((file) => file.slice(TASKS_DIR.length + 1))).toEqual([])
  })
})
