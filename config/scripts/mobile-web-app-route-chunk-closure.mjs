import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { entryStaticClosure, mobileWebAppBuildOptions } from './build-mobile-web-app-bundle.mjs'
import { collectMobileWebAppRoutes } from './mobile-web-app-route-manifest.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile', import.meta.url))

/**
 * What a browser must download before one page route can paint, and what it may defer.
 *
 * `mobileWebAppRouteClosure` answers a different question: it reads `metafile.inputs`, which holds
 * every module an entry reaches including the ones behind `import()`, so it cannot say "on
 * demand" about anything (ruling 28). This walks the emitted chunks instead, from the output the
 * route's own module landed in, and follows only `import-statement` edges — which is exactly where
 * a dynamic import stops being part of the download.
 *
 * Both halves come back, because the interesting claim is always a difference: `staticInputs` is
 * what the route costs to open, `deferredInputs` is everything else the bundle emitted, and a
 * module absent from the first is only meaningful while it is present in the second.
 */
export async function mobileWebAppRouteChunkClosure(routeModule) {
  const routes = await collectMobileWebAppRoutes(join(mobileDir, 'app'))
  const { metafile } = await esbuild.build({
    ...mobileWebAppBuildOptions(routes),
    metafile: true,
    write: false
  })
  const routePath = resolve(mobileDir, routeModule)
  const owner = Object.entries(metafile.outputs).find(([, output]) =>
    Object.keys(output.inputs ?? {}).some((input) => resolve(mobileDir, input) === routePath)
  )
  if (!owner) {
    throw new Error(`[mobile-web-app-route-chunk-closure] ${routeModule} reached no output`)
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
