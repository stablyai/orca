import { realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))

export const LAZY_ENTRY_NAMESPACE = 'orca-lazy-entry'
export const ROUTE_ENTRY_NAMESPACE = 'orca-route-entry'

export const isScriptOutput = (path) => path.endsWith('.js')

// Budget entry plus transitive static imports, stopping at dynamic imports; entry-only limits let shared initial chunks grow unseen.
export function entryStaticClosure(metafile, entryOutputPath) {
  const reached = new Set([entryOutputPath])
  for (const current of reached) {
    for (const imported of metafile.outputs[current]?.imports ?? []) {
      if (imported.kind !== 'import-statement' || reached.has(imported.path)) {
        continue
      }
      reached.add(imported.path)
    }
  }
  return reached
}

// esbuild cuts a chunk per set of routes sharing a module; one this small costs more as a request than as code every route loads.
const MERGED_SHARED_CHUNK_MAX_BYTES = 16 * 1024

// Small route-shared chunks whose static imports already load at boot or merge too, so merging adds only their own bytes.
// ESM only: a bare import runs a CommonJS module's body at route load, not where its importer first needs it.
export function sharedModulesToMerge(metafile, entryOutputPath) {
  const { inputs, outputs } = metafile
  const boot = entryStaticClosure(metafile, entryOutputPath)
  const routeReached = new Set(
    Object.entries(outputs)
      .filter(([, output]) => output.entryPoint?.startsWith(`${ROUTE_ENTRY_NAMESPACE}:`))
      .flatMap(([path]) => [...entryStaticClosure(metafile, path)])
  )
  const merged = new Set(
    Object.entries(outputs)
      .filter(
        ([path, output]) =>
          isScriptOutput(path) &&
          !output.entryPoint &&
          !boot.has(path) &&
          routeReached.has(path) &&
          output.bytes <= MERGED_SHARED_CHUNK_MAX_BYTES &&
          Object.keys(output.inputs).every((input) => inputs[input]?.format === 'esm')
      )
      .map(([path]) => path)
  )
  const importsUnmerged = (path) =>
    outputs[path].imports.some(
      ({ kind, path: imported }) =>
        kind === 'import-statement' && !boot.has(imported) && !merged.has(imported)
    )
  for (let dropped = true; dropped;) {
    dropped = false
    for (const path of merged) {
      if (importsUnmerged(path)) {
        merged.delete(path)
        dropped = true
      }
    }
  }
  return [...merged]
    .flatMap((path) => Object.keys(outputs[path].inputs))
    .sort()
    .map((input) => resolve(mobileDir, input))
}

// A lazy module sharing boot code gives those modules a new importer set, so esbuild would split the boot chunks;
// anchor it like a route. Modules boot imports lazily (routes, catalogs) stay as they are: anchoring them is an output cycle.
// esbuild's runtime helper chunk has no inputs and every chunk imports it, so self-contained engines (mermaid) keep their bytes.
export function lazyModulesToAnchor(metafile, entryOutputPath) {
  const { outputs } = metafile
  const boot = entryStaticClosure(metafile, entryOutputPath)
  const bootLoadsLazily = new Set(
    [...boot].flatMap((path) =>
      outputs[path].imports
        .filter(({ kind }) => kind === 'dynamic-import')
        .map(({ path: imported }) => imported)
    )
  )
  const sharesBootModules = ({ imports }) =>
    imports.some(
      ({ kind, path }) =>
        kind === 'import-statement' &&
        boot.has(path) &&
        Object.keys(outputs[path].inputs).length > 0
    )
  return new Map(
    Object.entries(outputs)
      .filter(
        ([path, output]) =>
          output.entryPoint &&
          !boot.has(path) &&
          !bootLoadsLazily.has(path) &&
          sharesBootModules(output)
      )
      .map(([, output]) => [realpathSync(resolve(mobileDir, output.entryPoint)), output.exports])
  )
}

// Resolve route imports through metafile inputs before content hashes erase source paths.
export function routeChunkNames(metafile, routes, renamed) {
  const owner = new Map()
  for (const [output, { inputs }] of Object.entries(metafile.outputs)) {
    for (const input of Object.keys(inputs ?? {})) {
      // realpath lookup matches esbuild’s symlink-resolved input keys (including macOS /var scratch paths).
      owner.set(resolve(mobileDir, input), basename(output))
    }
  }
  return Object.fromEntries(
    routes.map(({ key, module }) => {
      const emittedName = owner.get(realpathSync(module))
      if (!emittedName) {
        throw new Error(`[build-mobile-web-app-bundle] ${key} reached no output`)
      }
      return [key, renamed.get(emittedName).name]
    })
  )
}

// One lazily imported chunk per UI language; the page fetches only the active one after init.
const LOCALE_CATALOG_INPUT = /(^|\/)src\/i18n\/locales\/[^/]+\.json$/

export function localeCatalogOutputs(metafile) {
  return new Set(
    Object.entries(metafile.outputs)
      .filter(([, output]) => {
        const inputs = Object.keys(output.inputs ?? {})
        return inputs.length > 0 && inputs.every((input) => LOCALE_CATALOG_INPUT.test(input))
      })
      .map(([output]) => basename(output))
  )
}

// A host opens Commander only on request. Charge its own script to the on-demand budget
// only when every incoming edge loads it dynamically; shared dependencies remain eager.
export function commanderChunkOnDemand(metafile, renamed) {
  const screen = 'src/host-screen/host-commander-screen.tsx'
  const outputs = Object.entries(metafile.outputs)
  const chunk = outputs.find(
    ([, { entryPoint, inputs }]) =>
      Object.hasOwn(inputs, screen) &&
      (entryPoint === screen ||
        (entryPoint?.startsWith(`${LAZY_ENTRY_NAMESPACE}:`) &&
          resolve(entryPoint.slice(LAZY_ENTRY_NAMESPACE.length + 1)) ===
            resolve(mobileDir, screen)))
  )
  if (!chunk) {
    return null
  }
  const [path] = chunk
  const imports = outputs.flatMap(([, item]) => item.imports.filter((edge) => edge.path === path))
  if (!imports.length || !imports.every((edge) => edge.kind === 'dynamic-import')) {
    return null
  }
  const script = renamed.get(basename(path))
  return { name: script.name, byteLength: script.bytes.byteLength }
}

// The entry and its chunks, without locale catalogs: what the chunk fence and its sweep table count.
export function pageScriptCount(metafile) {
  const catalogs = localeCatalogOutputs(metafile)
  return Object.keys(metafile.outputs).filter(
    (output) => isScriptOutput(output) && !catalogs.has(basename(output))
  ).length
}
