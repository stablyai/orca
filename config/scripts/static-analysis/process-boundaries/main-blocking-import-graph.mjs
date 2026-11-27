import { build } from 'esbuild'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript-api'
import { createWorkspaceSourceResolver } from '../../workspace/source-exports/workspace-source-exports.mjs'
import { listTrackedFiles, readTrackedSources } from '../ratchet-baseline/ratchet-baseline.mjs'
import { unwrap } from '../module-requests/static-module-specifiers.mjs'
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
const EVENT_LOOP_SOURCE_ROOTS = ['src/main', 'src/shared', 'src/preload']

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

// esbuild does not follow `createRequire(...)('./x')`; without the edge a main-loaded module could look worker-only.
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']

function createRequireTargets(file, contents, sources) {
  const source = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true)
  const loaders = new Set()
  const targets = []
  const isCreateRequire = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'createRequire'
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isCreateRequire(node.initializer)
    ) {
      loaders.add(node.name.text)
    }
    if (
      ts.isCallExpression(node) &&
      (isCreateRequire(node.expression) ||
        (ts.isIdentifier(node.expression) && loaders.has(node.expression.text))) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.startsWith('.')
    ) {
      const base = path.posix.normalize(
        path.posix.join(path.posix.dirname(file), node.arguments[0].text)
      )
      const resolved = [
        base,
        ...RESOLVE_EXTENSIONS.map((ext) => `${base}${ext}`),
        ...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`)
      ].find((candidate) => sources.has(candidate))
      if (resolved) {
        targets.push(resolved)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return targets
}

/** Electron main, CLI, orcad and preload entries: guarded even when a worker happens to import one. */
export function eventLoopEntryFiles(root) {
  // Fixtures lack build config; a renamed main entry must not disable root validation in the real repo.
  const realRepo =
    listTrackedFiles(root, ['config/build-plugins/main-build-entry-points.ts']).length > 0
  const read = (file) => {
    try {
      return readFileSync(path.join(root, file), 'utf8')
    } catch {
      return ''
    }
  }
  const builtSource = read('config/build-plugins/main-build-entry-points.ts')
  const built = [...builtSource.matchAll(/resolve\(\s*(['"])([^'"]+)\1\s*\)/g)].map(
    (match) => match[2]
  )
  const cliSource = ts.createSourceFile(
    'cli-main-entry-names.ts',
    read('config/build-plugins/cli-main-entry-names.ts'),
    ts.ScriptTarget.Latest,
    true
  )
  const cliList = unwrap(
    cliSource.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find(
        (declaration) =>
          ts.isIdentifier(declaration.name) && declaration.name.text === 'CLI_MAIN_ENTRY_NAMES'
      )?.initializer
  )
  const validCli =
    cliSource.parseDiagnostics.length === 0 &&
    cliList &&
    ts.isArrayLiteralExpression(cliList) &&
    cliList.elements.every(ts.isStringLiteral)
  const cli = validCli ? cliList.elements.map((element) => `src/main/${element.text}.ts`) : []
  const preload = listTrackedFiles(root, ['src/preload']).filter(
    (file) => file.split('/').length === 3 && isMainBlockingSource(file)
  )
  const entries = [...built, ...cli, 'src/main/index.ts', 'src/main/orcad/main.ts', ...preload]
  if (realRepo) {
    const tracked = new Set(listTrackedFiles(root, entries))
    const missing = entries.filter(
      (file) => !tracked.has(file) || !existsSync(path.join(root, file))
    )
    // Every non-template resolve() in the entry list must be a literal we read, or a root went missing.
    const resolveCalls = (builtSource.match(/resolve\(\s*(?!`)/g) ?? []).length
    if (
      !built.includes('src/main/index.ts') ||
      built.length !== resolveCalls ||
      !validCli ||
      cli.length === 0 ||
      missing.length > 0
    ) {
      throw new Error(
        `main-blocking-import-graph: cannot read the event-loop entries from config/build-plugins (main ${built.length}, CLI ${cli.length}, missing: ${missing.join(', ') || 'none'}); update eventLoopEntryFiles`
      )
    }
  }
  return entries.filter((file) => !Object.hasOwn(MAIN_BLOCKING_WORKER_ENTRIES, file))
}

/** Files imported only beneath worker/utility entries; anything an event-loop file or entry imports stays guarded. */
export function workerOnlyFiles(graph, files, eventLoopEntries = []) {
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
  for (const entry of eventLoopEntries) {
    walk(entry, guarded)
  }
  for (const file of files) {
    if (!underWorker.has(file)) {
      walk(file, guarded)
    }
  }
  return new Set(files.filter((file) => underWorker.has(file) && !guarded.has(file)))
}

/** Tracked event-loop sources under `pathspecs`: main-blocking sources minus worker-only modules. */
export async function readEventLoopSources(root, pathspecs = EVENT_LOOP_SOURCE_ROOTS) {
  const sources = readTrackedSources(root, EVENT_LOOP_SOURCE_ROOTS, isMainBlockingSource)
  // Worker entries themselves are not main-blocking sources, but the graph must start from them.
  const entries = new Set(listTrackedFiles(root, Object.keys(MAIN_BLOCKING_WORKER_ENTRIES)))
  const graph = await collectImportGraph(root, [...sources.keys(), ...entries])
  for (const [file, contents] of sources) {
    if (contents.includes('createRequire')) {
      graph.set(file, [
        ...(graph.get(file) ?? []),
        ...createRequireTargets(file, contents, sources)
      ])
    }
  }
  const workerOnly = workerOnlyFiles(graph, [...sources.keys()], eventLoopEntryFiles(root))
  const inPathspecs = (file) =>
    pathspecs.some((spec) => file === spec || file.startsWith(`${spec}/`))
  return new Map([...sources].filter(([file]) => inPathspecs(file) && !workerOnly.has(file)))
}
