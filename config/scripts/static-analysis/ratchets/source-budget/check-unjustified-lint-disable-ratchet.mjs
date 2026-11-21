import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { readTrackedSources, runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'

// A lint suppression must say why; counts per file may only go down.

const BASELINE_PATH = 'config/unjustified-lint-disable-baseline.txt'
const SCAN_PATHSPECS = ['src/*.ts', 'src/*.tsx', 'src/*.mts', 'src/*.cts']
const DISABLE_DIRECTIVE = /(?:eslint|oxlint)-disable(?:-next-line|-line)?\b([^\n]*)/g

export function isScannedPath(rel) {
  return !/\.(?:test|spec)\.[cm]?tsx?$/.test(rel)
}

// A directive is justified when ` -- <reason>` follows the rule list.
export function countUnjustifiedDisables(sourceText) {
  let count = 0
  for (const [, rest] of sourceText.matchAll(DISABLE_DIRECTIVE)) {
    const reason = rest
      .split('*/')[0]
      .split(/\s--\s/)[1]
      ?.trim()
    if (!reason) {
      count += 1
    }
  }
  return count
}

export function collectUnjustifiedDisableCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, SCAN_PATHSPECS, isScannedPath)) {
    const count = countUnjustifiedDisables(source)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'unjustified-lint-disable',
      baselinePath: BASELINE_PATH,
      header: [
        '# eslint/oxlint-disable directives without a ` -- <reason>` in production src, per file.',
        '# This is a RATCHET: counts may only go DOWN.',
        '# Prune after adding reasons: pnpm check:unjustified-lint-disable-ratchet --prune'
      ],
      collect: collectUnjustifiedDisableCounts,
      unit: 'unjustified lint disable(s)',
      fix: [
        'Append the reason to the directive, e.g. `// oxlint-disable-next-line <rule> -- SAFETY: <why>`.',
        'Better: fix the code so the suppression is not needed.'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
