import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  diffCounts,
  parseCountBaseline,
  pruneCountBaseline,
  totalCount
} from './ratchet-baseline.mjs'
import { createGatedCallCollector } from './gated-call-use-collector.mjs'
import { isTestOnlySourcePath } from './test-only-source-path.mjs'

// Synchronous launches freeze all Electron windows; Windows antivirus magnifies the delay. Count launch APIs and synchronous wrappers per file.

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const BASELINE_PATH = 'config/main-sync-spawn-baseline.txt'
const SCAN_DIRECTORIES = ['src/main', 'src/shared']
const PROCESS_ADVICE = 'use runProcess or spawnProcess from @orca/process-host'
const SECURE_ADVICE = `rewrites a DACL on the calling thread, and a directory rewrite blocks on its whole subtree; use restrictWindowsDirectory for a directory, or raise this file's count in ${BASELINE_PATH} (or add a row)`
// Include package/repo re-exporters so moving an import cannot bypass the gate.
const GATED_FAMILIES = [
  {
    modules: ['child_process', 'node:child_process'],
    advice: { execFileSync: PROCESS_ADVICE, spawnSync: PROCESS_ADVICE, execSync: PROCESS_ADVICE }
  },
  { modules: ['@orca/process-host'], advice: { runProcessSync: PROCESS_ADVICE } },
  {
    modules: ['src/shared/secure-path-windows-acl'],
    advice: { restrictWindowsPathSync: SECURE_ADVICE }
  },
  {
    modules: [
      'src/main/git/command-runner/git-exec-file',
      'src/main/git/command-runner/git-exec-file-sync',
      'src/main/git/runner'
    ],
    advice: { gitExecFileSync: 'use gitExecFileAsync' }
  },
  {
    modules: ['src/main/wsl'],
    advice: {
      getWslHome: 'use getWslHomeAsync',
      listWslDistros: 'use listWslDistrosAsync',
      wslUncDirectoryExists: 'use wslUncDirectoryExistsAsync'
    }
  },
  {
    modules: ['src/main/wsl-availability', 'src/main/wsl'],
    advice: { isWslAvailable: 'use isWslAvailableAsync' }
  },
  { modules: ['src/main/pwsh'], advice: { isPwshAvailable: 'use isPwshAvailableAsync' } },
  { modules: ['src/main/win32-utils'], advice: { grantDirAcl: 'use grantDirAclAsync' } }
]
const collector = createGatedCallCollector(GATED_FAMILIES, 'sync-spawn')
const BASELINE_HEADER = [
  '# Synchronous child-process launches in production src/main and src/shared, per file: uses of',
  '# execFileSync/spawnSync/execSync, runProcessSync and the repo sync wrappers listed in',
  '# config/scripts/check-main-sync-spawn-ratchet.mjs (synchronous ACL rewrites and grants, which',
  '# can block on a whole directory subtree).',
  '# Some entries run in the daemon or orcad process, or are test harnesses outside the test-path',
  '# conventions. This is a RATCHET: counts may only go DOWN.',
  '# Prune after removing launches: pnpm check:main-sync-spawn-ratchet --prune'
]

function normalized(file) {
  return file.replaceAll('\\', '/')
}

export const gatedSymbolsFor = collector.gatedSymbolsFor
export const collectSyncLaunchUses = collector.collectUses
export const adviceFor = collector.adviceFor

export function isRatchetedSourcePath(file) {
  return (
    SCAN_DIRECTORIES.some((directory) => file.startsWith(`${directory}/`)) &&
    !file.endsWith('.d.ts') &&
    !isTestOnlySourcePath(file)
  )
}

export function countSyncSpawnUses(sources) {
  const counts = new Map()
  const symbols = new Map()
  for (const [file, contents] of sources) {
    if (!isRatchetedSourcePath(file)) {
      continue
    }
    const uses = collectSyncLaunchUses(file, contents)
    if (uses.count > 0) {
      counts.set(file, uses.count)
      symbols.set(file, uses.symbols)
    }
  }
  return { counts, symbols }
}

export function collectSyncSpawnSources(root = ROOT) {
  return new Map(
    globSync(
      SCAN_DIRECTORIES.map((directory) => `${directory}/**/*.{ts,tsx,mts,cts,js,mjs,cjs}`),
      { cwd: root, exclude: ['**/node_modules/**'] }
    )
      .map(normalized)
      .filter(isRatchetedSourcePath)
      .sort()
      .map((file) => [file, readFileSync(path.join(root, file), 'utf8')])
  )
}

export function main(root = ROOT) {
  const { counts, symbols } = countSyncSpawnUses(collectSyncSpawnSources(root))
  const { grown, shrunk } = diffCounts(
    counts,
    parseCountBaseline(readFileSync(path.join(root, BASELINE_PATH), 'utf8'))
  )
  for (const { file, now, allowed } of grown) {
    console.error(
      `::error file=${file}::${now} synchronous launch use(s), baseline allows ${allowed}. They block the main thread. ${adviceFor(symbols.get(file))}`
    )
  }
  for (const { file, now, allowed } of shrunk) {
    console.error(
      `::error file=${file}::${now} synchronous launch use(s), baseline still allows ${allowed}. Run: pnpm check:main-sync-spawn-ratchet --prune`
    )
  }
  if (grown.length + shrunk.length > 0) {
    return 1
  }
  console.log(
    `Main sync-spawn ratchet OK — ${totalCount(counts)} use(s) in ${counts.size} legacy file(s).`
  )
  return 0
}

export function prune(root = ROOT) {
  const { counts } = countSyncSpawnUses(collectSyncSpawnSources(root))
  const kept = pruneCountBaseline(root, BASELINE_PATH, BASELINE_HEADER, counts)
  console.log(`Pruned ${BASELINE_PATH} to ${kept} use(s).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--prune') {
    prune()
  }
  process.exitCode = main()
}
