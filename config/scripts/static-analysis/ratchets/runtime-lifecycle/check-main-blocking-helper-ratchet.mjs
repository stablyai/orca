import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGatedCallCollector } from '../../process-boundaries/gated-call-use-collector.mjs'
import { collectSqliteCallSites } from '../../process-boundaries/sqlite-call-use-collector.mjs'
import { readEventLoopSources } from '../../process-boundaries/main-blocking-import-graph.mjs'
import { collectBlockingHelperUses } from '../../process-boundaries/main-blocking-helper-propagation.mjs'
import { runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'
import { OFF_MAIN_ADVICE } from './check-main-blocking-api-ratchet.mjs'

const BASELINE_PATH = 'config/main-blocking-helper-baseline.txt'
const HELPER_DEPTH = 1
const BLOCKING_FAMILIES = [
  { modules: ['fs', 'node:fs', 'original-fs', 'graceful-fs'], exportPattern: /Sync$/, advice: {} },
  { modules: ['child_process', 'node:child_process'], exportPattern: /Sync$/, advice: {} }
]
const direct = createGatedCallCollector(BLOCKING_FAMILIES, 'main blocking helper')

export function collectDirectBlockingSites(sources) {
  const sites = new Map()
  for (const [file, contents] of sources) {
    const found = [
      ...direct.collectUses(file, contents).sites.map(({ name, position }) => ({
        position,
        reaches: `${name} in ${file}`
      })),
      ...collectSqliteCallSites(file, contents).map((position) => ({
        position,
        reaches: `SQLite in ${file}`
      }))
    ]
    if (found.length > 0) {
      sites.set(file, found)
    }
  }
  return sites
}

export async function collectMainBlockingHelperUses(root, depth) {
  const sources = await readEventLoopSources(root, ['src/main', 'src/shared', 'src/preload'])
  return collectBlockingHelperUses(sources, collectDirectBlockingSites(sources), { depth }).uses
}

export async function main(root = process.cwd(), arg = undefined) {
  const uses = await collectMainBlockingHelperUses(root, HELPER_DEPTH)
  const counts = new Map([...uses].map(([file, { count }]) => [file, count]))
  return runCountRatchet(
    {
      name: 'main-blocking-helper',
      baselinePath: BASELINE_PATH,
      header: [
        '# References to functions that make a synchronous fs, child_process or SQLite call, per file, in',
        '# event-loop code (Electron main, orcad, daemon, preload; worker-only modules excluded).',
        '# This is a RATCHET: counts may only go DOWN.',
        '# Prune: node config/scripts/static-analysis/ratchets/runtime-lifecycle/check-main-blocking-helper-ratchet.mjs --prune'
      ],
      collect: () => counts,
      detail: (file) => `Uses: ${uses.get(file)?.reaches.join(', ')}.`,
      pruneCommand:
        'node config/scripts/static-analysis/ratchets/runtime-lifecycle/check-main-blocking-helper-ratchet.mjs --prune',
      unit: 'blocking helper reference(s)',
      fix: [OFF_MAIN_ADVICE]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.cwd(), process.argv[2])
}
