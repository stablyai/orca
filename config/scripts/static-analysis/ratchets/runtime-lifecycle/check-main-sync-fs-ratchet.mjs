import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { createGatedCallCollector } from '../../process-boundaries/gated-call-use-collector.mjs'
import { runCountRatchet } from '../../ratchet-baseline/ratchet-baseline.mjs'
import { readEventLoopSources } from '../../process-boundaries/main-blocking-import-graph.mjs'

// Sync fs on Electron main stalls every window (and in the daemon/orcad, every terminal); per-spawn/RPC/focus stat and read sweeps were a recurring lag source (#39805, #35967, #38481).

const BASELINE_PATH = 'config/main-sync-fs-baseline.txt'
// src/shared runs on main too; leaving it out would let a helper move bypass the gate.
const SCAN_ROOTS = ['src/main', 'src/shared']
const ADVICE =
  'move CPU or SQL work to a worker, utility process or backend; async is right only for real I/O waits (node:fs/promises for filesystem waits)'
// Every *Sync export of node:fs (descriptor and copy APIs included), listed so the baseline doesn't depend on the runtime.
const SYNC_FS = [
  'accessSync',
  'appendFileSync',
  'chmodSync',
  'chownSync',
  'closeSync',
  'copyFileSync',
  'cpSync',
  'existsSync',
  'fchmodSync',
  'fchownSync',
  'fdatasyncSync',
  'fstatSync',
  'fsyncSync',
  'ftruncateSync',
  'futimesSync',
  'globSync',
  'lchmodSync',
  'lchownSync',
  'linkSync',
  'lstatSync',
  'lutimesSync',
  'mkdirSync',
  'mkdtempDisposableSync',
  'mkdtempSync',
  'openSync',
  'opendirSync',
  'readFileSync',
  'readSync',
  'readdirSync',
  'readlinkSync',
  'readvSync',
  'realpathSync',
  'renameSync',
  'rmSync',
  'rmdirSync',
  'statSync',
  'statfsSync',
  'symlinkSync',
  'truncateSync',
  'unlinkSync',
  'utimesSync',
  'writeFileSync',
  'writeSync',
  'writevSync'
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

export function countSyncFsCalls(rel, source) {
  return collector.collectUses(rel, source).count
}

export async function collectMainSyncFsCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of await readEventLoopSources(root, SCAN_ROOTS)) {
    const count = countSyncFsCalls(rel, source)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export async function main(root = process.cwd(), arg = undefined) {
  const counts = await collectMainSyncFsCounts(root)
  return runCountRatchet(
    {
      name: 'main-sync-fs',
      baselinePath: BASELINE_PATH,
      header: [
        '# Synchronous node:fs calls (every *Sync export) in production src/main and src/shared, per file;',
        '# modules imported only by worker/utility entries are excluded.',
        '# Startup-only or one-shot uses are fine to keep; per-RPC, per-spawn, per-focus or per-poll uses are the target.',
        '# This is a RATCHET: counts may only go DOWN.',
        '# Prune after removing calls: pnpm check:main-sync-fs-ratchet --prune'
      ],
      collect: () => counts,
      unit: 'sync fs call(s)',
      fix: [
        `Sync fs blocks the thread it runs on: Electron main (every window) or the daemon/orcad loop (every terminal). ${ADVICE}.`,
        `A one-shot startup or shutdown use may raise the file's count in ${BASELINE_PATH} with reviewer sign-off.`
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.cwd(), process.argv[2])
}
