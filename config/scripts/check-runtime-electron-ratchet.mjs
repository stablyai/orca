#!/usr/bin/env node
// Plain-Node runtime/CLI and all structured-chat lanes must remain Electron-free, including lanes not yet reachable.
// esbuild reachability catches cross-file edges lint cannot; any electron importer fails (baseline is zero).
import { build } from 'esbuild'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { isTestOnlyDirectoryName, isTestOnlySourcePath } from './test-only-source-path.mjs'
import { createWorkspaceSourceResolver } from './workspace-source-exports.mjs'

// Resolve from module location: CI/editors may run outside root; cwd-relative paths previously caused ENOENT.
const ROOT = path.join(import.meta.dirname, '..', '..')

const ENTRY_POINTS = [
  path.join(ROOT, 'src', 'main', 'runtime', 'orca-runtime.ts'),
  path.join(ROOT, 'src', 'main', 'runtime', 'runtime-rpc.ts'),
  // orcad imports ipc/pty directly; checking only runtime entries once missed regressions in its larger graph.
  path.join(ROOT, 'src', 'main', 'orcad', 'main.ts'),
  // Why the CLI: it runs under ELECTRON_RUN_AS_NODE, and its tsconfig follows imports into src/main.
  path.join(ROOT, 'src', 'cli', 'index.ts')
]

// Whole lane directories cover new files automatically; only structured-chat files are plain-Node-safe inside runtime/.
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

// Externalize every .node: optional ssh2/cpu-features prebuilds may exist locally but not CI; only the import graph matters.
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

export async function main({ plugins = [] } = {}) {
  const current = await collectElectronImporters(defaultEntryPoints(), {
    plugins
  })
  if (current.length > 0) {
    console.error(
      `[runtime-electron-ratchet] ${current.length} module(s) reachable from the Orca runtime, the CLI or structured-chat code import electron:
${current.map((file) => `  + ${file}`).join('\n')}

The runtime and structured chat must run in orcad, the headless runtime, and the CLI runs on
plain Node; Electron is unavailable in both. That holds for structured-chat code the runtime
doesn't load yet, so renaming or moving the file is not a fix. Put the Electron facility behind a port in src/main/host/ and
depend on the port, or drop the import that pulls Electron in.`
    )
    return 1
  }
  console.log('[runtime-electron-ratchet] ok — nothing reachable imports electron.')
  return 0
}

// pathToFileURL handles Windows drive/backslash argv paths; a file:// template silently skipped the gate there.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
