import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { createGatedCallCollector } from '../../process-boundaries/gated-call-use-collector.mjs'
import { readTrackedSources, runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'
import { isTestOnlySourcePath } from '../../process-boundaries/test-only-source-path.mjs'

// Sync fs on Electron main stalls every window; per-spawn/RPC/focus stat and read sweeps were a recurring lag source (#39805, #35967, #38481).

const BASELINE_PATH = 'config/main-sync-fs-baseline.txt'
const SCAN_ROOTS = ['src/main']
const ADVICE =
  'use node:fs/promises, or cache the result on a stat fingerprint outside the hot path'
const SYNC_FS = [
  'accessSync',
  'appendFileSync',
  'copyFileSync',
  'existsSync',
  'lstatSync',
  'mkdirSync',
  'openSync',
  'readFileSync',
  'readdirSync',
  'realpathSync',
  'renameSync',
  'rmSync',
  'statSync',
  'unlinkSync',
  'writeFileSync'
]
const collector = createGatedCallCollector(
  [
    {
      modules: ['fs', 'node:fs', 'original-fs', 'graceful-fs'],
      advice: Object.fromEntries(SYNC_FS.map((name) => [name, ADVICE]))
    }
  ],
  'main sync-fs'
)

function isScannedPath(rel) {
  return /\.[cm]?[jt]sx?$/.test(rel) && !rel.endsWith('.d.ts') && !isTestOnlySourcePath(rel)
}

export function countSyncFsCalls(rel, source) {
  return collector.collectUses(rel, source).count
}

export function collectMainSyncFsCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, SCAN_ROOTS, isScannedPath)) {
    const count = countSyncFsCalls(rel, source)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'main-sync-fs',
      baselinePath: BASELINE_PATH,
      header: [
        `# Synchronous node:fs calls in production src/main, per file: ${SYNC_FS.join(', ')}.`,
        '# Startup-only or one-shot uses are fine to keep; per-RPC, per-spawn, per-focus or per-poll uses are the target.',
        '# This is a RATCHET: counts may only go DOWN.',
        '# Prune after removing calls: pnpm check:main-sync-fs-ratchet --prune'
      ],
      collect: collectMainSyncFsCounts,
      unit: 'sync fs call(s)',
      fix: [
        `Sync fs blocks the Electron main thread and every window with it: ${ADVICE}.`,
        `A one-shot startup or shutdown use may raise the file's count in ${BASELINE_PATH} with reviewer sign-off.`
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
