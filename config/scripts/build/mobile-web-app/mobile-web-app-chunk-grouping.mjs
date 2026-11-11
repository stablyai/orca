import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))

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
