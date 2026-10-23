// Why: the host registry is the only place that binds a method name to its params
// schema. Reading it back — instead of hand-listing 600 methods — is what keeps the
// shared catalog and the dispatcher from drifting apart.
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import * as esbuild from 'esbuild'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
export const RPC_PARAMS_CATALOG_PATH = path.join(
  'src',
  'shared',
  'rpc-contract',
  'rpc-params-catalog.generated.ts'
)

// Why a root parameter: the cross-version harness derives the catalog for an extracted
// release tree, which no longer carries it in git.
function catalogPaths(root) {
  const sharedDir = path.join(root, 'src', 'shared')
  const rpcDir = path.join(root, 'src', 'main', 'runtime', 'rpc')
  return {
    root,
    sharedDir,
    contractDir: path.join(sharedDir, 'rpc-contract'),
    rpcDir,
    registryEntry: path.join(rpcDir, 'methods', 'index.ts'),
    outputPath: path.join(root, RPC_PARAMS_CATALOG_PATH)
  }
}

// Why mkdirSync first: out/ is gitignored and absent on a fresh checkout. Why not
// os.tmpdir(): the bundle keeps its node_modules deps external, so it has to sit
// under the tree, and the tree under a directory whose node_modules resolves them.
function scratchDir(root, prefix) {
  const out = path.join(root, 'out')
  mkdirSync(out, { recursive: true })
  return mkdtempSync(path.join(out, prefix))
}

const posix = (value) => value.split(path.sep).join('/')

// Every module the catalog may import from: the extracted params modules plus the
// pre-existing src/shared schemas the RPC methods already bind directly.
function indexableModules({ sharedDir, contractDir, rpcDir, outputPath }) {
  // Tests are excluded here for the same reason as the rpcDir walk below: bundling one pulls
  // vitest into the CJS catalog build, which throws on require().
  const modules = new Set(
    globSync('*.ts', { cwd: contractDir })
      .filter((name) => !name.endsWith('.test.ts'))
      .map((name) => path.join(contractDir, name))
  )
  modules.delete(outputPath)
  for (const file of globSync('**/*.ts', { cwd: rpcDir })) {
    if (file.endsWith('.test.ts')) {
      continue
    }
    const source = readFileSync(path.join(rpcDir, file), 'utf8')
    for (const [, specifier] of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const resolved = `${path.resolve(path.dirname(path.join(rpcDir, file)), specifier)}.ts`
      // Never re-add the generator's own output: a module under rpcDir may import the
      // catalog for a type-only contract, and bundling a stale catalog makes regeneration
      // crash in exactly the state that requires regenerating.
      if (
        resolved !== outputPath &&
        resolved.startsWith(`${sharedDir}${path.sep}`) &&
        existsSync(resolved)
      ) {
        modules.add(resolved)
      }
    }
  }
  return [...modules].sort()
}

// Why: one bundle keeps the registry and the shared modules on the same module
// instances, so schema object identity is what maps a method to its export.
function loadRegistryAndSchemas({ root, registryEntry }, modules) {
  const buildDir = scratchDir(root, 'rpc-params-catalog-')
  try {
    const entry = path.join(buildDir, 'entry.ts')
    const importOf = (file) => JSON.stringify(posix(path.relative(buildDir, file)))
    writeFileSync(
      entry,
      [
        `export { ALL_RPC_METHODS } from ${importOf(registryEntry)}`,
        'export const SCHEMA_MODULES = {',
        ...modules.map(
          (file) =>
            `  ${JSON.stringify(posix(path.relative(root, file)))}: require(${importOf(file)}),`
        ),
        '}'
      ].join('\n')
    )
    const outfile = path.join(buildDir, 'bundle.cjs')
    esbuild.buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      logLevel: 'error',
      packages: 'external',
      // Why: the catalog types every method a build can register, every dark switch's included.
      define: { ORCA_LAYOUT_OWNER: '"main"', ORCA_SIDEBAR_INPUTS: '"main"' }
    })
    const loaded = createRequire(import.meta.url)(outfile)
    return { methods: loaded.ALL_RPC_METHODS, schemaModules: loaded.SCHEMA_MODULES }
  } finally {
    rmSync(buildDir, { recursive: true, force: true })
  }
}

// Why: schema objects are compared by identity, not by shape — two structurally
// identical schemas are still two different wire contracts.
function buildSchemaIndex(schemaModules) {
  const index = new Map()
  for (const [modulePath, moduleExports] of Object.entries(schemaModules)) {
    for (const [exportName, value] of Object.entries(moduleExports)) {
      if (!value || typeof value !== 'object' || typeof value.safeParse !== 'function') {
        continue
      }
      if (index.has(value)) {
        continue
      }
      index.set(value, { modulePath, exportName })
    }
  }
  return index
}

function localNameFor(origin, taken) {
  if (!taken.has(origin.exportName)) {
    return origin.exportName
  }
  const hint = path
    .basename(origin.modulePath, '.ts')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
  let candidate = `${origin.exportName}Of${hint}`
  let suffix = 2
  while (taken.has(candidate)) {
    candidate = `${origin.exportName}Of${hint}${suffix++}`
  }
  return candidate
}

function render({ root, contractDir }, { methods, schemaModules }) {
  const index = buildSchemaIndex(schemaModules)
  const entries = []
  const uncataloged = []
  const imports = new Map()
  const taken = new Set()

  for (const method of [...methods].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    if (method.params === null) {
      entries.push(`  '${method.name}': null`)
      continue
    }
    const origin = index.get(method.params)
    if (!origin) {
      uncataloged.push(method.name)
      continue
    }
    const key = `${origin.modulePath}#${origin.exportName}`
    let local = imports.get(key)
    if (!local) {
      local = localNameFor(origin, taken)
      taken.add(local)
      imports.set(key, local)
    }
    entries.push(`  '${method.name}': ${local}`)
  }

  const byModule = new Map()
  for (const [key, local] of imports) {
    const [modulePath, exportName] = key.split('#')
    if (!byModule.has(modulePath)) {
      byModule.set(modulePath, [])
    }
    byModule.get(modulePath).push(local === exportName ? exportName : `${exportName} as ${local}`)
  }
  const importLines = [...byModule]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([modulePath, names]) => {
      let specifier = posix(path.relative(contractDir, path.join(root, modulePath))).replace(
        /\.ts$/,
        ''
      )
      if (!specifier.startsWith('.')) {
        specifier = `./${specifier}`
      }
      return `import { ${names.sort().join(', ')} } from '${specifier}'`
    })

  return `// GENERATED by config/scripts/generate-rpc-params-catalog.mjs (run by build:packages).
// Gitignored build output; do not edit.
import type { z } from 'zod'
${importLines.join('\n')}

// Why: the host parses params with these schemas, so a client that matches this map
// matches the dispatcher. Clients must import it for types only — parsing a params
// schema client-side runs the coercing transforms and rewrites the wire bytes.
export const RPC_PARAMS_BY_METHOD = {
${entries.join(',\n')}
} as const

// Why: these methods bind a schema the shared contract cannot hold because its value
// graph reaches into src/main. Listing them keeps the gap visible instead of absent.
export const RPC_METHODS_WITHOUT_SHARED_PARAMS: readonly string[] = [
${uncataloged.map((name) => `  '${name}'`).join(',\n')}
]

export type RpcMethodName = keyof typeof RPC_PARAMS_BY_METHOD

// Why: z.output is the post-parse shape the handler receives, which is not what a
// client may send — a .default() field reads as required. z.input is not the answer
// either: requiredString is z.unknown().transform(...), so its input admits any value.
// Senders use RpcSendParams from ./rpc-send-params, which is derived from this map.
export type RpcParams<Method extends RpcMethodName> =
  (typeof RPC_PARAMS_BY_METHOD)[Method] extends z.ZodType
    ? z.output<(typeof RPC_PARAMS_BY_METHOD)[Method]>
    : void
`
}

/** Derive the catalog for the tree at `root` and write it only when its content changed. */
export function writeRpcParamsCatalog(root = REPO_ROOT) {
  const paths = catalogPaths(root)
  const generated = render(paths, loadRegistryAndSchemas(paths, indexableModules(paths)))
  // Why compare first: an unchanged mtime keeps incremental tsc and dev watchers idle.
  if (existsSync(paths.outputPath) && readFileSync(paths.outputPath, 'utf8') === generated) {
    return false
  }
  // Why rename: a concurrent tsc, vitest or dev watcher never reads a half-written module.
  const staged = `${paths.outputPath}.${process.pid}.tmp`
  writeFileSync(staged, generated)
  renameSync(staged, paths.outputPath)
  return true
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const rootFlag = process.argv.indexOf('--root')
  if (
    writeRpcParamsCatalog(rootFlag === -1 ? REPO_ROOT : path.resolve(process.argv[rootFlag + 1]))
  ) {
    console.log(`wrote ${posix(RPC_PARAMS_CATALOG_PATH)}`)
  }
}
