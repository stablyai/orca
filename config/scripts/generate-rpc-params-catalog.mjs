// Why: the host registry is the only place that binds a method name to its params
// schema. Reading it back — instead of hand-listing 600 methods — is what keeps the
// shared catalog and the dispatcher from drifting apart.
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import * as esbuild from 'esbuild'
import { resolveOxcCliInvocation } from './oxc-cli-invocation.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const SHARED_DIR = path.join(REPO_ROOT, 'src', 'shared')
const CONTRACT_DIR = path.join(SHARED_DIR, 'rpc-contract')
const RPC_DIR = path.join(REPO_ROOT, 'src', 'main', 'runtime', 'rpc')
const REGISTRY_ENTRY = path.join(RPC_DIR, 'methods', 'index.ts')
const OUTPUT_PATH = path.join(CONTRACT_DIR, 'rpc-params-catalog.generated.ts')

// Why mkdirSync first: out/ is gitignored and absent on a fresh checkout, so
// mkdtempSync threw ENOENT and took `pnpm lint` down with it. Why not os.tmpdir():
// the bundle keeps its node_modules deps external and oxfmt reads .oxfmtrc.json by
// walking up, so both scratch files have to sit under the repo to resolve at all.
function scratchDir(prefix) {
  const root = path.join(REPO_ROOT, 'out')
  mkdirSync(root, { recursive: true })
  return mkdtempSync(path.join(root, prefix))
}

const posix = (value) => value.split(path.sep).join('/')
const repoPath = (absolute) => posix(path.relative(REPO_ROOT, absolute))

// Every module the catalog may import from: the extracted params modules plus the
// pre-existing src/shared schemas the RPC methods already bind directly.
function indexableModules() {
  const modules = new Set(
    globSync('*.ts', { cwd: CONTRACT_DIR }).map((name) => path.join(CONTRACT_DIR, name))
  )
  modules.delete(OUTPUT_PATH)
  for (const file of globSync('**/*.ts', { cwd: RPC_DIR })) {
    if (file.endsWith('.test.ts')) {
      continue
    }
    const source = readFileSync(path.join(RPC_DIR, file), 'utf8')
    for (const [, specifier] of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const resolved = `${path.resolve(path.dirname(path.join(RPC_DIR, file)), specifier)}.ts`
      if (resolved.startsWith(`${SHARED_DIR}${path.sep}`) && existsSync(resolved)) {
        modules.add(resolved)
      }
    }
  }
  return [...modules].sort()
}

// Why: one bundle keeps the registry and the shared modules on the same module
// instances, so schema object identity is what maps a method to its export.
function loadRegistryAndSchemas(modules) {
  const buildDir = scratchDir('rpc-params-catalog-')
  try {
    const entry = path.join(buildDir, 'entry.ts')
    const importOf = (file) => JSON.stringify(posix(path.relative(buildDir, file)))
    writeFileSync(
      entry,
      [
        `export { ALL_RPC_METHODS } from ${importOf(REGISTRY_ENTRY)}`,
        'export const SCHEMA_MODULES = {',
        ...modules.map(
          (file) => `  ${JSON.stringify(repoPath(file))}: require(${importOf(file)}),`
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
      packages: 'external'
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

function render({ methods, schemaModules }) {
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
      let specifier = posix(path.relative(CONTRACT_DIR, path.join(REPO_ROOT, modulePath))).replace(
        /\.ts$/,
        ''
      )
      if (!specifier.startsWith('.')) {
        specifier = `./${specifier}`
      }
      return `import { ${names.sort().join(', ')} } from '${specifier}'`
    })

  return `// GENERATED by config/scripts/generate-rpc-params-catalog.mjs. Do not edit;
// run \`pnpm run generate:rpc-params-catalog\`.
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

// Why: the drift gate compares bytes, so the generator must emit exactly what the
// formatter would produce or every run would look like drift.
function formatted(source) {
  const buildDir = scratchDir('rpc-params-catalog-fmt-')
  try {
    const file = path.join(buildDir, 'rpc-params-catalog.generated.ts')
    writeFileSync(file, source)
    const { command, prefixArgs } = resolveOxcCliInvocation('oxfmt', 'oxfmt', REPO_ROOT)
    execFileSync(command, [...prefixArgs, '--write', file], {
      stdio: 'ignore',
      windowsHide: true
    })
    return readFileSync(file, 'utf8')
  } finally {
    rmSync(buildDir, { recursive: true, force: true })
  }
}

function main() {
  const check = process.argv.includes('--check')
  const generated = formatted(render(loadRegistryAndSchemas(indexableModules())))
  const current = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, 'utf8') : null
  if (generated === current) {
    if (!check) {
      console.log(`rpc params catalog already up to date: ${repoPath(OUTPUT_PATH)}`)
    }
    return
  }
  if (check) {
    console.error(
      `${repoPath(OUTPUT_PATH)} is out of date. Run \`pnpm run generate:rpc-params-catalog\`.`
    )
    process.exitCode = 1
    return
  }
  writeFileSync(OUTPUT_PATH, generated)
  console.log(`wrote ${repoPath(OUTPUT_PATH)}`)
}

main()
