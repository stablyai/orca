import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { createGatedCallCollector } from './gated-call-use-collector.mjs'
import { readTrackedSources, runCountRatchet } from './ratchet-baseline.mjs'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

// The terminal daemon and orcad serve every pane from one event loop; a blocking call there freezes all of them (#34410).

const BASELINE_PATH = 'config/daemon-blocking-call-baseline.txt'
const SCAN_ROOTS = ['src/main/daemon', 'src/main/pty', 'src/main/runtime', 'src/main/orcad']
const PROCESS_ADVICE = 'use runProcess or spawnProcess from @orca/process-host'
const WRITE_ADVICE = 'use an async write or a buffered stream'
const BLOCKING_CALLS = [
  {
    modules: ['child_process', 'node:child_process'],
    advice: { execFileSync: PROCESS_ADVICE, spawnSync: PROCESS_ADVICE, execSync: PROCESS_ADVICE }
  },
  { modules: ['@orca/process-host'], advice: { runProcessSync: PROCESS_ADVICE } },
  {
    modules: ['fs', 'node:fs'],
    advice: { appendFileSync: WRITE_ADVICE, writeSync: WRITE_ADVICE }
  }
]
const collector = createGatedCallCollector(BLOCKING_CALLS, 'daemon blocking-call')

function isScannedPath(rel) {
  return /\.[cm]?[jt]sx?$/.test(rel) && !rel.endsWith('.d.ts') && !isTestOnlySourcePath(rel)
}

export function countBlockingCalls(rel, source) {
  return collector.collectUses(rel, source).count
}

export function collectDaemonBlockingCallCounts(root = process.cwd()) {
  const counts = new Map()
  for (const [rel, source] of readTrackedSources(root, SCAN_ROOTS, isScannedPath)) {
    const count = countBlockingCalls(rel, source)
    if (count > 0) {
      counts.set(rel, count)
    }
  }
  return counts
}

export function main(root = process.cwd(), arg = undefined) {
  return runCountRatchet(
    {
      name: 'daemon-blocking-call',
      baselinePath: BASELINE_PATH,
      header: [
        '# Event-loop-blocking calls in the terminal daemon, PTY and orcad runtime code, per file:',
        '# execFileSync/spawnSync/execSync, runProcessSync, appendFileSync and writeSync.',
        '# This is a RATCHET: counts may only go DOWN.',
        '# Prune after removing calls: pnpm check:daemon-blocking-call-ratchet --prune'
      ],
      collect: collectDaemonBlockingCallCounts,
      unit: 'blocking call(s)',
      fix: [
        `Child processes: ${PROCESS_ADVICE}. File writes: ${WRITE_ADVICE}.`,
        'One stalled call freezes every terminal the daemon or orcad serves.'
      ]
    },
    root,
    arg
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.cwd(), process.argv[2]))
}
