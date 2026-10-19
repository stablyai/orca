#!/usr/bin/env node
/**
 * Ratchet gate for Electron imports reachable from the Orca runtime and structured chat.
 *
 * The runtime boots on plain Node, where Electron is unavailable. Keep desktop
 * dependencies out of its graph, including structured chat not yet wired into it.
 *
 * This bundles the runtime and the structured-chat lanes with esbuild and reads the metafile for
 * every module that imports `electron`. Any such module fails: the migration reached zero.
 *
 * This is a reachability check, not a lint rule: the point is precisely the edges
 * that no per-file rule can see.
 *
 * Usage: node config/scripts/check-runtime-electron-ratchet.mjs
 */
import { build } from 'esbuild'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { isTestOnlyDirectoryName, isTestOnlySourcePath } from './test-only-source-path.mjs'
import { createWorkspaceSourceResolver } from './workspace-source-exports.mjs'

// Why absolute, not cwd-relative: `pnpm lint` runs from the repo root but CI steps and
// editors do not always, and a cwd-relative miss surfaced as an unhandled ENOENT stack
// instead of a usable message.
const ROOT = path.join(import.meta.dirname, '..', '..')

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
  { directory: ['src', 'packages', 'process-host', 'src'] },
  {
    directory: ['src', 'main', 'runtime'],
    basename: /^(?:structured-|agent-session-)/
  },
  { directory: ['src', 'main', 'provider-process'] },
  { directory: ['src', 'main', 'acp'] },
  { directory: ['src', 'main', 'jsonl-rpc'] },
  { directory: ['src', 'main', 'pi'], basename: /^rpc-/ }
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
// relay build already does (config/scripts/build-wsl-guest.mjs).
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
    pluginBuild.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true
    }))
  }
}

// Why `plugins`: lets a test add an Electron import to a real file in memory, never on disk.
export async function collectElectronImporters(entryPoints, { plugins = [] } = {}) {
  const workspace = createWorkspaceSourceResolver(ROOT)
  const workspaceSources = {
    name: 'runtime-workspace-sources',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^@orca\// }, ({ path: specifier }) => {
        const source = workspace.resolve(specifier)
        return source ? { path: source.path } : undefined
      })
    }
  }
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
    plugins: [externalNativeAddons, workspaceSources, ...plugins]
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

// Exported so tests run the CLI path itself; `plugins` is the same in-memory hook as above.
export async function main({ plugins = [] } = {}) {
  const current = await collectElectronImporters(defaultEntryPoints(), {
    plugins
  })
  if (current.length > 0) {
    console.error(
      `[runtime-electron-ratchet] ${current.length} module(s) reachable from the Orca runtime or structured-chat code import electron:
${current.map((file) => `  + ${file}`).join('\n')}

The runtime and structured chat must run in orcad, the headless runtime, where Electron is
unavailable. That holds for structured-chat code the runtime doesn't load yet, so renaming or
moving the file is not a fix. Put the Electron facility behind a port in src/main/host/ and
depend on the port, or drop the import that pulls Electron in.`
    )
    return 1
  }
  console.log('[runtime-electron-ratchet] ok — nothing reachable imports electron.')
  return 0
}

// Why pathToFileURL and not a `file://` template: on Windows process.argv[1] is a
// native path (C:\repo\...) while import.meta.url is file:///C:/repo/..., so the
// template never matches and the gate would exit 0 without checking anything — a
// lint gate that fails open. Same idiom as check-max-lines-ratchet.mjs:225.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
