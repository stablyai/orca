import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'
import { resolveOxlintInvocation } from '../../../tool-invocation/oxlint-cli-invocation.mjs'

// Ratchet whole fleet-map selectors downward: each re-renders its owner whenever any host, pane, tab or worktree changes.

const BASELINE_PATH = 'config/whole-hot-map-selector-baseline.txt'
const CONFIG_PATH = 'config/oxlint-whole-hot-map-ratchet.json'
const RULE = 'app-store-performance(no-whole-hot-map-selector)'
const FIELD = /^The whole (\w+) map /
export const HEADER = [
  '# Store selectors returning a whole fleet-keyed map, per file and field.',
  '# This is a RATCHET: counts may only go DOWN. Select a stable derived answer instead.',
  '# Prune after a fix: pnpm check:whole-hot-map-selector-ratchet --prune'
]

/** `file:field` → number of selectors in that file returning the whole map. */
export function countWholeHotMapSelectors(diagnostics, root = process.cwd()) {
  const counts = new Map()
  for (const diagnostic of diagnostics) {
    const field = diagnostic.code === RULE ? FIELD.exec(diagnostic.message)?.[1] : undefined
    if (field) {
      const file = path.relative(root, path.resolve(root, diagnostic.filename))
      const key = `${file.split(path.sep).join('/')}:${field}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

export function collectWholeHotMapSelectorCounts(root = process.cwd()) {
  const oxlint = resolveOxlintInvocation(path.resolve(root))
  // Warnings exit 0; a parse or plugin failure exits non-zero and throws here.
  const output = execFileSync(
    oxlint.command,
    [...oxlint.prefixArgs, '--config', CONFIG_PATH, '--format', 'json', 'src/renderer/src'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }
  )
  return countWholeHotMapSelectors(JSON.parse(output).diagnostics, path.resolve(root))
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'whole-hot-map-selector',
      baselinePath: BASELINE_PATH,
      header: HEADER,
      collect: collectWholeHotMapSelectorCounts,
      unit: 'whole fleet-map selector(s)',
      fix: [
        'A selector that returns a whole fleet-keyed map re-renders its component whenever any',
        'entry changes, which is every status update at fleet scale. Select the derived answer',
        'for your own item with a stable result, or, when this consumer needs every entry, add',
        '`// oxlint-disable-next-line app-store-performance/no-whole-hot-map-selector -- <why>`.'
      ]
    },
    path.resolve(root),
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
