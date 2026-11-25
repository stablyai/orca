import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGatedCallCollector } from '../../process-boundaries/gated-call-use-collector.mjs'
import { collectSqliteCallSites } from '../../process-boundaries/sqlite-call-use-collector.mjs'
import { readEventLoopSources } from '../../process-boundaries/main-blocking-import-graph.mjs'
import { collectBlockingHelperUses } from '../../process-boundaries/main-blocking-helper-propagation.mjs'
import { runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'
import { OFF_MAIN_ADVICE } from './check-main-blocking-api-ratchet.mjs'

const BASELINE_PATH = 'config/main-blocking-helper-baseline.txt'
// Two levels: a timer or handler calling a function that calls the sync reader (the 11-09 and 11-13 regressions).
const HELPER_DEPTH = 2
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

export async function collectMainBlockingHelperUses(root, depth, sources = undefined) {
  const eventLoopSources = sources ?? (await readEventLoopSources(root))
  return collectBlockingHelperUses(eventLoopSources, collectDirectBlockingSites(eventLoopSources), {
    depth
  }).uses
}

export async function main(root = process.cwd(), arg = undefined, sources = undefined) {
  const uses = await collectMainBlockingHelperUses(root, HELPER_DEPTH, sources)
  const counts = new Map([...uses].map(([file, { count }]) => [file, count]))
  return runCountRatchet(
    {
      name: 'main-blocking-helper',
      baselinePath: BASELINE_PATH,
      header: [
        '# References to functions that make a synchronous fs, child_process or SQLite call, or call such a',
        '# function, per file, in event-loop code (Electron main, orcad, daemon, preload; worker-only modules excluded).',
        '# This is a RATCHET: counts may only go DOWN.',
        '# Prune: node config/scripts/static-analysis/ratchets/runtime-lifecycle/check-main-blocking-helper-ratchet.mjs --prune'
      ],
      collect: () => counts,
      detail: (file) => `Uses: ${uses.get(file)?.reaches.join(', ')}.`,
      pruneCommand:
        'node config/scripts/static-analysis/ratchets/runtime-lifecycle/check-main-blocking-helper-ratchet.mjs --prune',
      unit: 'blocking helper reference(s)',
      fix: [
        `Each listed helper makes a synchronous fs, child_process or SQLite call, or calls one that does. ${OFF_MAIN_ADVICE}`,
        'If a helper itself just became blocking, fix it there: every file that calls it is charged.',
        "Names match file-wide: a local or parameter that reuses an imported helper's name is counted; rename it.",
        `A one-shot startup or shutdown call may raise the file's row in ${BASELINE_PATH} with reviewer sign-off and a trailing "# why" note.`
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.cwd(), process.argv[2])
}
