import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { runE2eTypecheck } from './run-e2e-typecheck.mjs'
import {
  diffCounts,
  parseCountBaseline,
  pruneCountBaseline,
  totalCount
} from './ratchet-baseline.mjs'

// Ratchet tests/ type errors downward: missing helpers otherwise hide until gated hosts run their specs (#30231).

const BASELINE_PATH = 'config/e2e-typecheck-baseline.txt'
const HEADER = [
  '# Type errors per file under tests/ (tsc -p config/tsconfig.e2e.json).',
  '# This is a RATCHET: counts may only go DOWN. Fix the errors in a file you touch.',
  '# Prune after a fix: pnpm check:e2e-typecheck-ratchet --prune'
]

// Count tests/ only; imported mobile/cloud errors vary with each CI job’s installed workspaces.
const TEST_ERROR_ROW = /^(tests\/[^(\s]+)\(\d+,\d+\): error TS\d+:/

export function countTestTypeErrors(tscOutput) {
  const counts = new Map()
  for (const line of tscOutput.split(/\r?\n/)) {
    const match = TEST_ERROR_ROW.exec(line)
    if (match) {
      counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
    }
  }
  return counts
}

export function main(
  root = process.cwd(),
  arg = undefined,
  tscOutput = runE2eTypecheck({ root }).output
) {
  const current = countTestTypeErrors(tscOutput)
  if (arg === '--prune') {
    const total = pruneCountBaseline(root, BASELINE_PATH, HEADER, current)
    console.log(`e2e-typecheck baseline pruned to ${total}.`)
    return 0
  }
  const baselineFile = path.join(root, BASELINE_PATH)
  const baseline = parseCountBaseline(
    fs.existsSync(baselineFile) ? fs.readFileSync(baselineFile, 'utf8') : ''
  )
  const { grown, shrunk } = diffCounts(current, baseline)
  for (const { file, now, allowed } of grown) {
    console.error(`${file}: ${now} type error(s), baseline allows ${allowed}.`)
  }
  if (grown.length > 0) {
    const grownFiles = new Set(grown.map(({ file }) => file))
    let showing = false
    for (const line of tscOutput.split(/\r?\n/)) {
      const row = TEST_ERROR_ROW.exec(line)
      showing = row ? grownFiles.has(row[1]) : showing && /^\s/.test(line)
      if (showing) {
        console.error(line)
      }
    }
    console.error(`See the errors with: pnpm typecheck:e2e`)
  }
  for (const { file, now, allowed } of shrunk) {
    console.error(`${file}: now ${now}, baseline ${allowed}.`)
  }
  if (shrunk.length > 0) {
    console.error('The baseline may only shrink. Fix it: pnpm check:e2e-typecheck-ratchet --prune')
  }
  if (grown.length + shrunk.length > 0) {
    return 1
  }
  console.log(`e2e-typecheck ratchet OK — ${totalCount(current)} grandfathered error(s).`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
