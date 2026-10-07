#!/usr/bin/env node
/**
 * Ratchet gate for Electron imports reachable from the Orca runtime and structured chat.
 *
 * The runtime boots on plain Node, where Electron is unavailable. Keep desktop
 * dependencies out of its graph, including structured chat not yet wired into it.
 *
 * This bundles the runtime and the structured-chat lanes with esbuild, reads the metafile for every module that
 * imports `electron`, and compares that set to a checked-in baseline. A NEW module
 * fails the build; a removed one must be dropped from the baseline. The baseline
 * may only shrink, so the migration is measurable and cannot regress.
 *
 * This is a reachability check, not a lint rule: the point is precisely the edges
 * that no per-file rule can see.
 *
 * Usage: node config/scripts/check-runtime-electron-ratchet.mjs [--write]
 */
import { build } from 'esbuild'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { isTestOnlyDirectoryName, isTestOnlySourcePath } from './test-only-source-path.mjs'

// Why absolute, not cwd-relative: `pnpm lint` runs from the repo root but CI steps and
// editors do not always, and a cwd-relative miss surfaced as an unhandled ENOENT stack
// instead of a usable message.
const ROOT = path.join(import.meta.dirname, '..', '..')
const BASELINE_PATH = path.join(ROOT, 'config', 'runtime-electron-baseline.txt')

// The two module graphs a Node backend would have to boot: the runtime service
// itself and the RPC server that fronts it.
const ENTRY_POINTS = [
  path.join(ROOT, 'src', 'main', 'runtime', 'orca-runtime.ts'),
  path.join(ROOT, 'src', 'main', 'runtime', 'runtime-rpc.ts'),
  // Why orcad too: it imports ipc/pty directly to install the PTY controller, so its
  // graph is strictly larger than the two runtime entries. Measuring only those let the
  // two numbers drift — the gate would read zero while the shipped artifact regressed.
  path.join(ROOT, 'src', 'main', 'orcad', 'main.ts')
]

// Code that must run in orcad whether or not a runtime entry reaches it yet. Whole directories,
// so a new file is covered by default; src/main/runtime still holds desktop-only code (browser
// commands, desktop relay), so only its structured-chat files are entries there.
export const STRUCTURED_CHAT_LANES = [
  { directory: ['src', 'main', 'native-chat'] },
  { directory: ['src', 'main', 'claude'] },
  { directory: ['src', 'main', 'codex'] },
  { directory: ['src', 'shared'] },
  { directory: ['src', 'main', 'runtime'], basename: /^(?:structured-|agent-session-)/ },
  { directory: ['src', 'main', 'provider-process'] },
  { directory: ['src', 'main', 'acp'] }
]

export function collectStructuredChatEntryPoints(root = ROOT) {
  return STRUCTURED_CHAT_LANES.flatMap((lane) => {
    const directory = path.join(root, ...lane.directory)
    if (!existsSync(directory)) {
      throw new Error(
        `[runtime-electron-ratchet] ${lane.directory.join('/')} is missing. If it moved, update STRUCTURED_CHAT_LANES; otherwise the gate would silently check nothing there.`
      )
    }
    return collectLaneFiles(directory, lane.basename)
  }).sort()
}

function collectLaneFiles(directory, basename) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      return isTestOnlyDirectoryName(entry.name) ? [] : collectLaneFiles(file, basename)
    }
    return entry.isFile() &&
      /\.[cm]?[jt]sx?$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !isTestOnlySourcePath(entry.name) &&
      (!basename || basename.test(entry.name))
      ? [file]
      : []
  })
}

/** What the CLI and CI check: the runtime graph plus every structured-chat lane file. */
export function defaultEntryPoints(root = ROOT) {
  return [...ENTRY_POINTS, ...collectStructuredChatEntryPoints(root)]
}

// Native addons and electron cannot be bundled; externalising them is what the
// relay build already does (config/scripts/build-relay.mjs).
const EXTERNAL = [
  'electron',
  'node-pty',
  '@parcel/watcher',
  'better-sqlite3',
  'keytar',
  'fsevents',
  'cpu-features'
]

/**
 * Why: some optional native deps (ssh2's cpu-features) reference a prebuilt `.node`
 * that only exists where a build toolchain has run. Resolving them made this gate
 * pass on a developer machine and hard-fail on CI. Nothing here needs the addon —
 * only the import graph — so mark every `.node` external instead.
 */
const externalNativeAddons = {
  name: 'external-native-addons',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, external: true }))
  }
}

// Why `plugins`: lets a test add an Electron import to a real file in memory, never on disk.
export async function collectElectronImporters(entryPoints, { plugins = [] } = {}) {
  const result = await build({
    // Export every entry through one bundle so shared dependencies are emitted once.
    stdin: {
      contents: entryPoints
        .map(
          (entry, index) =>
            `export * as entry_${index} from ${JSON.stringify(path.resolve(ROOT, entry))}`
        )
        .join('\n'),
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'runtime-electron-ratchet-entry.ts'
    },
    bundle: true,
    write: false,
    outdir: path.join(ROOT, 'runtime-electron-ratchet-metafile-only'),
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: EXTERNAL,
    metafile: true,
    absWorkingDir: ROOT,
    logLevel: 'silent',
    plugins: [externalNativeAddons, ...plugins]
  })
  const importers = new Set()
  for (const [file, info] of Object.entries(result.metafile.inputs)) {
    for (const imported of info.imports ?? []) {
      // Subpaths (electron/main) are as unavailable under plain Node as the bare module.
      if (imported.path === 'electron' || imported.path.startsWith('electron/')) {
        importers.add(path.relative(ROOT, path.resolve(ROOT, file)).split(path.sep).join('/'))
      }
    }
  }
  return [...importers].sort()
}

export function readBaseline(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .sort()
}

export function diffAgainstBaseline(current, baseline) {
  const baselineSet = new Set(baseline)
  const currentSet = new Set(current)
  return {
    added: current.filter((file) => !baselineSet.has(file)),
    removed: baseline.filter((file) => !currentSet.has(file))
  }
}

function renderBaseline(files) {
  return [
    '# Modules reachable from the Orca runtime or structured-chat code that import `electron`.',
    '# Generated by config/scripts/check-runtime-electron-ratchet.mjs.',
    '# This list is EMPTY and must stay that way: both run in orcad, the headless runtime,',
    '# on plain Node (see `pnpm run build:orcad`). Any entry means that code got less portable;',
    '# migrate the module behind a host port instead (src/main/host/).',
    '',
    ...files
  ].join('\n')
}

// Exported so tests run the CLI path itself; `plugins` is the same in-memory hook as above.
export async function main(argv = process.argv, { plugins = [] } = {}) {
  const write = argv.includes('--write')
  const current = await collectElectronImporters(defaultEntryPoints(), { plugins })

  if (write) {
    writeFileSync(BASELINE_PATH, `${renderBaseline(current)}\n`)
    console.log(`[runtime-electron-ratchet] wrote ${current.length} entries to ${BASELINE_PATH}`)
    return 0
  }

  const baseline = readBaseline(readFileSync(BASELINE_PATH, 'utf8'))
  const { added, removed } = diffAgainstBaseline(current, baseline)

  if (added.length > 0) {
    console.error(
      `[runtime-electron-ratchet] ${added.length} new module(s) reachable from the Orca runtime or structured-chat code now import electron:
${added.map((file) => `  + ${file}`).join('\n')}

The runtime and structured chat must run in orcad, the headless runtime, where Electron is
unavailable. That holds for structured-chat code the runtime doesn't load yet, so renaming or
moving the file is not a fix. Put the Electron facility behind a port in src/main/host/ and
depend on the port, or drop the import that pulls Electron in.`
    )
    return 1
  }

  if (removed.length > 0) {
    console.error(
      `[runtime-electron-ratchet] ${removed.length} module(s) no longer import electron — nice.
Refresh the baseline so the gate keeps its new, tighter floor:
${removed.map((file) => `  - ${file}`).join('\n')}

  node config/scripts/check-runtime-electron-ratchet.mjs --write`
    )
    return 1
  }

  console.log(`[runtime-electron-ratchet] ok — ${current.length} entries, unchanged.`)
  return 0
}

// Why pathToFileURL and not a `file://` template: on Windows process.argv[1] is a
// native path (C:\repo\...) while import.meta.url is file:///C:/repo/..., so the
// template never matches and the gate would exit 0 without checking anything — a
// lint gate that fails open. Same idiom as check-max-lines-ratchet.mjs:225.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
