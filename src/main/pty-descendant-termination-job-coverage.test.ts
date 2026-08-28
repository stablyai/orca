import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every production `killWithDescendantSweep` call must pass `terminateOwnedTree`.
 *
 * Why a scan and not a type: the option is optional by design — a POSIX-only
 * caller has no job to offer — so nothing makes omitting it an error. And the
 * cost of omitting it is invisible in review: the sweep silently falls back to
 * a parent-pid walk that a detached, reparented grandchild is not in, so the
 * process holding the worktree cwd survives the delete (#9045, #10475, #10897).
 * That is exactly the shape #11047 measured: the job was wired into
 * `local-pty-provider.ts`, worktree delete ran through the daemon instead, and
 * the fix engaged on neither of the paths that actually execute.
 */
const SRC_DIR = join(__dirname, '..')
const CALL = 'killWithDescendantSweep('
const EXPECTED_MINIMUM_SITES = 5

function collectTypeScriptFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') {
        continue
      }
      found.push(...collectTypeScriptFiles(path))
      continue
    }
    if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      found.push(path)
    }
  }
  return found
}

/** The call's argument text, brace-matched so a nested object literal stays whole. */
function readCallArguments(source: string, callIndex: number): string {
  let depth = 0
  for (let index = callIndex + CALL.length - 1; index < source.length; index += 1) {
    const char = source[index]
    if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1
      if (depth === 0) {
        return source.slice(callIndex, index)
      }
    }
  }
  return source.slice(callIndex)
}

describe('pty job ownership covers every descendant sweep', () => {
  const sites: { file: string; args: string }[] = []
  for (const file of collectTypeScriptFiles(SRC_DIR)) {
    const source = readFileSync(file, 'utf8')
    if (file.endsWith('pty-descendant-termination.ts')) {
      continue // the implementation itself
    }
    let index = source.indexOf(CALL)
    while (index !== -1) {
      sites.push({ file: relative(SRC_DIR, file), args: readCallArguments(source, index) })
      index = source.indexOf(CALL, index + CALL.length)
    }
  }

  it('scans a realistic number of call sites', () => {
    // Guards against a rename quietly turning every assertion below vacuous.
    expect(sites.length).toBeGreaterThanOrEqual(EXPECTED_MINIMUM_SITES)
  })

  it.each(sites.map((site, index) => [`${site.file} #${index}`, site] as const))(
    '%s passes terminateOwnedTree',
    (_label, site) => {
      expect(site.args).toContain('terminateOwnedTree')
    }
  )
})
