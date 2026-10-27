import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { baseRuleId, scanAstGrep } from './ast-grep-scan.mjs'
import { resolvePullRequestDiffBase } from './git-pull-request-diff-base.mjs'
import { listTrackedFiles, runCountRatchet } from './ratchet-baseline.mjs'

// Count each flaky-test rule per file so fixing one pattern cannot pay for adding another.

const BASELINE_PATH = 'config/flaky-test-pattern-baseline.txt'
const RULE_FILTER = '^test-'
const FLAKY_RULE = new RegExp(RULE_FILTER)
const HEADER = [
  '# Flaky-test pattern findings per rule and file (config/ast-grep/rules/flaky-tests).',
  '# This is a RATCHET: counts may only go DOWN. Run `pnpm lint:ast-grep:flaky-tests` to list them.',
  '# Prune after a fix: pnpm check:flaky-test-pattern-ratchet --prune'
]

export function countFindings(matches, isTracked = () => true) {
  const counts = new Map()
  for (const match of matches) {
    const file = match.file.split('\\').join('/')
    if (!isTracked(file)) {
      continue
    }
    const key = `${baseRuleId(match.ruleId)}:${file}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/** `matches` may come from an unfiltered scan another gate shares; only `test-*` rules count. */
export function collectFlakyTestPatternCounts(root = process.cwd(), matches = undefined) {
  // Tracked files only, so untracked scratch never changes the baseline.
  const tracked = new Set(listTrackedFiles(root, []))
  const flaky = (matches ?? scanAstGrep(root, { filter: RULE_FILTER })).filter((match) =>
    FLAKY_RULE.test(match.ruleId)
  )
  return countFindings(flaky, (file) => tracked.has(file))
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
}

// Scope enforcement to changed files so unrelated merges cannot invalidate every PR's baseline.
export function listChangedFiles(root = process.cwd()) {
  if (process.env.ORCA_FLAKY_TEST_RATCHET_ALL === '1') {
    return null
  }
  let base
  try {
    const requested = process.env.ORCA_CODE_QUALITY_BASE || 'origin/main'
    const mergeBase = git(root, ['merge-base', 'HEAD', requested]).trim()
    base = resolvePullRequestDiffBase(root, mergeBase)
  } catch {
    try {
      base = resolvePullRequestDiffBase(root, undefined)
    } catch {
      return null
    }
  }
  if (!base) {
    return null
  }
  const changed = git(root, ['diff', '--name-only', '--no-renames', base])
    .split('\n')
    .filter(Boolean)
  return new Set(changed)
}

export function changedFileScope(changed) {
  if (!changed) {
    return undefined
  }
  return (key) => changed.has(key.slice(key.indexOf(':') + 1))
}

export function main(root = process.cwd(), arg = undefined, matches = undefined) {
  return runCountRatchet(
    {
      name: 'flaky-test-pattern',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: (dir) => collectFlakyTestPatternCounts(dir, matches),
      scope: (dir) => changedFileScope(listChangedFiles(dir)),
      unit: 'flaky-test finding(s)',
      fix: [
        'Wait on the condition (expect.poll, vi.waitFor, locator assertions) instead of sleeping or',
        'polling, use fake timers or fixed timestamps instead of the wall clock, put',
        '`// quarantine: #<issue> <reason>` above a skip, and a reason comment above a timeout bump.',
        'A deliberate exception takes `// ast-grep-ignore: <rule-id> -- <reason>` above the line.'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
