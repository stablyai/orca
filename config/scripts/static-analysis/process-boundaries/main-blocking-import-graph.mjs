import { build } from 'esbuild'
import path from 'node:path'
import { createWorkspaceSourceResolver } from '../../workspace/source-exports/workspace-source-exports.mjs'
import { listTrackedFiles, readTrackedSources } from '../ratchet-baseline/ratchet-baseline.mjs'
import {
  isMainBlockingSource,
  MAIN_BLOCKING_WORKER_ENTRIES
} from './main-blocking-source-paths.mjs'

const EXTERNAL = [
  'electron',
  'node-pty',
  '@parcel/watcher',
  'better-sqlite3',
  'keytar',
  'fsevents',
  'cpu-features'
]

const externalNativeAddons = {
  name: 'external-native-addons',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\.node$|\?[\w&]+$/ }, (args) => ({
      path: args.path,
      external: true
    }))
  }
}

/** Repo-relative file -> repo-relative files it imports, for every scanned source in one bundle pass. */
export async function collectImportGraph(root, files) {
  const workspace = createWorkspaceSourceResolver(root)
  const result = await build({
    stdin: {
      contents: files
        .map(
          (file, index) => `export * as m${index} from ${JSON.stringify(path.resolve(root, file))}`
        )
        .join('\n'),
      resolveDir: root,
      loader: 'ts',
      sourcefile: 'main-blocking-import-graph-entry.ts'
    },
    bundle: true,
    write: false,
    outdir: path.join(root, 'main-blocking-import-graph-metafile-only'),
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external: EXTERNAL,
    packages: 'external',
    metafile: true,
    absWorkingDir: root,
    logLevel: 'silent',
    plugins: [
      externalNativeAddons,
      {
        name: 'main-blocking-workspace-sources',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^@orca\// }, ({ path: specifier }) => {
            const source = workspace.resolve(specifier)
            return source ? { path: source.path } : undefined
          })
        }
      }
    ]
  })
  const relative = (file) => path.relative(root, path.resolve(root, file)).split(path.sep).join('/')
  const graph = new Map()
  for (const [file, info] of Object.entries(result.metafile.inputs)) {
    graph.set(
      relative(file),
      (info.imports ?? []).filter((edge) => !edge.external).map((edge) => relative(edge.path))
    )
  }
  return graph
}

/** Files imported only beneath worker/utility entries; anything an event-loop file imports stays guarded. */
export function workerOnlyFiles(graph, files) {
  const entries = new Set(Object.keys(MAIN_BLOCKING_WORKER_ENTRIES))
  const underWorker = new Set()
  const walk = (start, seen) => {
    const stack = [start]
    while (stack.length > 0) {
      const file = stack.pop()
      if (seen.has(file)) {
        continue
      }
      seen.add(file)
      stack.push(...(graph.get(file) ?? []))
    }
  }
  for (const entry of entries) {
    walk(entry, underWorker)
  }
  const guarded = new Set()
  for (const file of files) {
    if (!underWorker.has(file)) {
      walk(file, guarded)
    }
  }
  return new Set(files.filter((file) => underWorker.has(file) && !guarded.has(file)))
}

/** Tracked event-loop sources under `pathspecs`: main-blocking sources minus worker-only modules. */
export async function readEventLoopSources(root, pathspecs) {
  const sources = readTrackedSources(
    root,
    ['src/main', 'src/shared', 'src/preload'],
    isMainBlockingSource
  )
  // Worker entries themselves are not main-blocking sources, but the graph must start from them.
  const entries = new Set(listTrackedFiles(root, Object.keys(MAIN_BLOCKING_WORKER_ENTRIES)))
  const graph = await collectImportGraph(root, [...sources.keys(), ...entries])
  const workerOnly = workerOnlyFiles(graph, [...sources.keys()])
  const inPathspecs = (file) =>
    pathspecs.some((spec) => file === spec || file.startsWith(`${spec}/`))
  return new Map([...sources].filter(([file]) => inPathspecs(file) && !workerOnly.has(file)))
}
