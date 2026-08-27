import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))
const SCAN_ROOT = join(REPO_ROOT, 'src')

/**
 * Why this ratchet: the per-PR queue probe is one extra GraphQL call. It is only
 * affordable because every caller is a SINGLE-PR lookup gated on
 * `mergeQueueRequired === true`. Wiring it into a list path would fan out N calls
 * per refresh and blow the rate limit — a queued PR reading as `open` in a list
 * row is the correct, intended degradation instead.
 */
const ALLOWED_CALLERS = [
  'src/main/github/client/lookup/pull-request-lookup-hydration.ts',
  'src/main/github/client/fetch/work-item-fetch.ts'
]

const PROBE_MODULE = 'pull-request-merge-queue-entry'

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out') {
      continue
    }
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      found.push(...sourceFilesUnder(full))
      continue
    }
    if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      found.push(full)
    }
  }
  return found
}

describe('merge-queue probe call sites', () => {
  it('is imported only by single-PR lookups, never by a list path', () => {
    const importers = sourceFilesUnder(SCAN_ROOT)
      .filter((file) => !file.endsWith(`${PROBE_MODULE}.ts`))
      .filter((file) => readFileSync(file, 'utf8').includes(PROBE_MODULE))
      .map((file) => relative(REPO_ROOT, file).split('\\').join('/'))
      .sort()
    expect(importers).toEqual([...ALLOWED_CALLERS].sort())
  })

  it('keeps the list-path merge-metadata hydration probe-free', () => {
    const listHydration = readFileSync(
      join(SCAN_ROOT, 'main/github/client/detect/hydrate-work-item-merge-metadata.ts'),
      'utf8'
    )
    expect(listHydration).not.toContain(PROBE_MODULE)
    expect(listHydration).not.toContain('mergeQueueEntry')
  })
})
