import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { entryStaticClosure, mobileWebAppBuildOptions } from '../build-mobile-web-app-bundle.mjs'
import { collectMobileWebAppRoutes } from './mobile-web-app-route-manifest.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile', import.meta.url))

// Match resolved web sibling in output metafile; named native .tsx may never appear because resolveExtensions prefers .web.tsx.
function chunkOwnerPaths(routeModule) {
  const named = resolve(mobileDir, routeModule)
  const sibling = named.replace(/\.(tsx?)$/, '.web.$1')
  return sibling === named ? [named] : [sibling, named]
}

// Walk emitted chunks’ import-statement edges for initial download cost; input closure includes dynamic imports and cannot prove laziness.
// Return deferred inputs too: absence from static inputs matters only when module still exists elsewhere in bundle.
export async function mobileWebAppRouteChunkClosure(routeModule) {
  const routes = await collectMobileWebAppRoutes(join(mobileDir, 'app'))
  const { metafile } = await esbuild.build({
    ...mobileWebAppBuildOptions(routes),
    metafile: true,
    write: false
  })
  const routePaths = chunkOwnerPaths(routeModule)
  const owner = Object.entries(metafile.outputs).find(([, output]) =>
    Object.keys(output.inputs ?? {}).some((input) => routePaths.includes(resolve(mobileDir, input)))
  )
  if (!owner) {
    throw new Error(
      `[mobile-web-app-route-chunk-closure] ${routeModule} reached no output (tried ${routePaths.join(', ')})`
    )
  }
  const reached = entryStaticClosure(metafile, owner[0])
  const inputsOf = (outputs) =>
    outputs.flatMap((output) => Object.keys(metafile.outputs[output]?.inputs ?? {}))
  const every = Object.keys(metafile.outputs).filter((output) => output.endsWith('.js'))
  return {
    routeChunk: basename(owner[0]),
    staticChunks: [...reached].map((output) => basename(output)),
    staticInputs: inputsOf([...reached]),
    deferredInputs: inputsOf(every.filter((output) => !reached.has(output)))
  }
}
