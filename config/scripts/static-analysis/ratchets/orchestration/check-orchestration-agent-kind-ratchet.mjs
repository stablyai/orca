import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { scanAstGrep } from '../../structural-scan/ast-grep-scan.mjs'
import { listTrackedFiles, runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'

// Orchestration code that branches on terminal vs chat; new sites fail so both kinds share one path.

const BASELINE_PATH = 'config/orchestration-agent-kind-baseline.txt'
const RULE_ID = 'orchestration-agent-kind-branch'
const HEADER = [
  `# Agent-kind branches per file (config/ast-grep/rules/${RULE_ID}.yml).`,
  '# This is a RATCHET: counts may only go DOWN. Prune after a fix:',
  '# pnpm check:orchestration-agent-kind-ratchet --prune'
]

/** `matches` may come from an unfiltered scan another gate shares; only this rule counts. */
export function collectAgentKindCounts(root = process.cwd(), matches = undefined) {
  // Tracked files only, so untracked scratch never changes the baseline.
  const tracked = new Set(listTrackedFiles(root, []))
  const counts = new Map()
  for (const match of matches ?? scanAstGrep(root, { filter: `^${RULE_ID}$` })) {
    const file = match.file.split('\\').join('/')
    if (match.ruleId === RULE_ID && tracked.has(file)) {
      counts.set(file, (counts.get(file) ?? 0) + 1)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined, matches = undefined) {
  return runCountRatchet(
    {
      name: 'orchestration-agent-kind',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: (dir) => collectAgentKindCounts(dir, matches),
      unit: 'agent-kind branch(es)',
      fix: [
        'Use the party src/main/runtime/orchestration/addressing resolves instead of reading the',
        'address or agent mode, and declare a per-kind refusal in orchestration-parity.md.',
        `A deliberate exception takes \`// ast-grep-ignore: ${RULE_ID} -- <reason>\` above the line.`
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
