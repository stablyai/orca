import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { baseRuleId, scanAstGrep } from './ast-grep-scan.mjs'
import { listTrackedFiles, runCountRatchet } from './ratchet-baseline.mjs'

// Ratchet on the flaky-test ast-grep rules in config/ast-grep/rules/flaky-tests: wall-clock reads,
// real-time waits, polling loops, unquarantined skips, and unexplained timeout bumps. Each row
// counts one rule in one file, so fixing one pattern cannot pay for adding another.

const BASELINE_PATH = 'config/flaky-test-pattern-baseline.txt'
const RULE_FILTER = '^test-'
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

export function collectFlakyTestPatternCounts(root = process.cwd()) {
  // Tracked files only, so untracked scratch never changes the baseline.
  const tracked = new Set(listTrackedFiles(root, []))
  return countFindings(scanAstGrep(root, { filter: RULE_FILTER }), (file) => tracked.has(file))
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'flaky-test-pattern',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: collectFlakyTestPatternCounts,
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
