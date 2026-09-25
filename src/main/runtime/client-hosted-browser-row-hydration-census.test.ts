import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { glob } from 'tinyglobby'

const REPO_ROOT = join(import.meta.dirname, '../../..')
const CENSUS_FILE = 'src/main/runtime/client-hosted-browser-row-hydration-census.test.ts'

/**
 * `deliverHydrationSnapshot` reads like a getter and is not one: it replaces the publisher's record
 * of which workspaces the renderer holds rows for. A second caller that reasonably treats it as a
 * peek — a status panel, a diagnostic dump, a second window's look-ahead — would clear that record
 * out from under the live renderer, and the rows it is showing become unretractable. That is the
 * exact defect this round shipped a fix for, so the single-caller shape is pinned rather than
 * trusted to the name.
 */
async function countCallSites(pattern: RegExp): Promise<Record<string, number>> {
  const files = await glob(['src/**/*.ts', 'src/**/*.tsx'], {
    cwd: REPO_ROOT,
    ignore: ['**/node_modules/**', '**/*.test.ts', '**/*.test.tsx', CENSUS_FILE]
  })
  const counts: Record<string, number> = {}
  for (const file of files) {
    // Counted per file, not merely detected: two call sites in one file mask each other.
    const hits = readFileSync(join(REPO_ROOT, file), 'utf8').match(pattern)?.length ?? 0
    if (hits > 0) {
      counts[file] = hits
    }
  }
  return counts
}

// Anchored on the member-call shape rather than the bare name, so the declaration does not count
// itself and prose about the method does not have to be kept out of the file.
const DELIVER_CALL = /\.deliverHydrationSnapshot\(/g
const LIST_CALL = /\.listClientHostedBrowserRows\(/g

describe('client-hosted row hydration caller census', () => {
  it('keeps the hydration delivery to its one runtime caller', async () => {
    expect(await countCallSites(DELIVER_CALL)).toEqual({
      'src/main/runtime/orca-runtime-stored-mobile-snapshot-has-stale-preserved-tab.ts': 1
    })
  })

  // The IPC handler is the other half of the same invariant: it is what turns one renderer's
  // hydration request into one delivery, so a second production reader would arrive through here.
  it('keeps the runtime accessor to its one IPC caller', async () => {
    expect(await countCallSites(LIST_CALL)).toEqual({
      'src/main/ipc/runtime.ts': 1
    })
  })

  // Why: the two censuses above pass by finding what is already there, so a matcher that had
  // stopped matching would read the same as a clean repo. Prove it counts a second caller.
  it('counts a second caller rather than reporting the same single site', () => {
    const source = `
      const a = runtime.deliverHydrationSnapshot()
      const b = other.deliverHydrationSnapshot()
    `
    expect(source.match(DELIVER_CALL)?.length).toBe(2)
    expect('runtime.listClientHostedBrowserRows()'.match(LIST_CALL)?.length).toBe(1)
  })
})
