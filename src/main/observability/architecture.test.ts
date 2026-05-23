// Architectural-invariant test (telemetry-error-tracking.md §Architecture):
//
//   "Nothing in `src/main/telemetry/` imports from `src/main/observability/`
//    or vice versa. The two lanes never share a code path."
//
// Cross-contamination is the failure mode the entire two-lane split is
// counter-designed against. oxlint's plugin set does not include
// `import-x`, and adding eslint just for this rule is a heavier lift than
// the rule warrants. A vitest test that grep-scans the two directories is
// adequate, runs in <50 ms, and fails CI loudly if a future PR adds the
// wrong import.
//
// What it catches:
//   - any `from '../observability'` / `from '../observability/...'` inside
//     `src/main/telemetry/`
//   - any `from '../telemetry'` / `from '../telemetry/...'` inside
//     `src/main/observability/`
//   - the same with deeper relative paths (`../../observability/...`)
//   - the same with absolute-from-src forms if anyone introduces them
//
// What it does NOT catch:
//   - dynamic `await import()` / `require()` — neither lane uses these,
//     and adding a regex catch would create false positives. If a future
//     change introduces dynamic loading, extend the regex set.
//   - re-exports through a third module. The simplest workaround
//     (re-export `observability` from a "neutral" module) is the same
//     anti-pattern this test is preventing; reviewers should reject it.
//
// Both directions of the rule are checked symmetrically — the asymmetric
// alternative (only one-way) leaves the door open to a `setOptIn` →
// `bundle` callback chain that smuggles consent state across the boundary.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(__dirname, '..', '..', '..')
const TELEMETRY_DIR = join(REPO_ROOT, 'src', 'main', 'telemetry')
const OBSERVABILITY_DIR = join(REPO_ROOT, 'src', 'main', 'observability')

function listTsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full))
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

function findOffendingImports(file: string, forbiddenSegment: string): string[] {
  const text = readFileSync(file, 'utf8')
  // Match `from '<path>'`, `from "<path>"`, dynamic `import('<path>')` and
  // `require('<path>')`. The `<path>` capture is what we inspect.
  const importRe = /(?:from\s+|import\(|require\()\s*(['"])([^'"]+)\1/g
  const offenders: string[] = []
  let m: RegExpExecArray | null
  while ((m = importRe.exec(text)) !== null) {
    const spec = m[2]
    if (spec.includes(forbiddenSegment)) {
      offenders.push(spec)
    }
  }
  return offenders
}

describe('architectural invariant — telemetry / observability lane isolation', () => {
  it('no file in src/main/telemetry/ imports from observability', () => {
    const files = listTsFiles(TELEMETRY_DIR)
    expect(files.length).toBeGreaterThan(0) // sanity: directory exists
    const violations = files.flatMap((f) => {
      const bad = findOffendingImports(f, 'observability')
      return bad.map((spec) => `${relative(REPO_ROOT, f)}: imports '${spec}'`)
    })
    expect(violations, violations.join('\n')).toEqual([])
  })

  it('no file in src/main/observability/ imports from telemetry', () => {
    const files = listTsFiles(OBSERVABILITY_DIR)
    expect(files.length).toBeGreaterThan(0)
    const violations = files.flatMap((f) => {
      // Allow this very file — the test references the path string for its
      // own message, and the whitelist is one specific filename rather than
      // a directory exemption.
      if (f.endsWith('architecture.test.ts')) {
        return []
      }
      const bad = findOffendingImports(f, 'telemetry')
      return bad.map((spec) => `${relative(REPO_ROOT, f)}: imports '${spec}'`)
    })
    expect(violations, violations.join('\n')).toEqual([])
  })
})
