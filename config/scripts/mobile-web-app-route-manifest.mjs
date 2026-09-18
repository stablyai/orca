import { readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import * as esbuild from 'esbuild'

/** The route subtree the page mounts. The rest of mobile/app is native-only (pairing, settings). */
export const MOBILE_WEB_APP_ROUTE_ROOT = 'h'

const ROUTE_FILE = /\.[tj]sx?$/
const NOT_A_ROUTE = /(\.(test|spec|d)\.|\+api\.|\+middleware\.)/
// esbuild's resolveExtensions order, which only applies to an extensionless import. Routes are
// imported by full path, so the web sibling is picked here instead.
const WEB_SIBLING_EXTENSIONS = ['.web.tsx', '.web.ts', '.web.jsx', '.web.js']

function webSiblingOf(name, siblings) {
  const stem = name.slice(0, name.length - extname(name).length)
  return WEB_SIBLING_EXTENSIONS.map((extension) => `${stem}${extension}`).find((candidate) =>
    siblings.has(candidate)
  )
}

/**
 * Every route in the mounted subtree, sorted by key so the generated module is a pure function of
 * the tree on disk. `key` is the require.context key expo-router names the screen by, always the
 * native filename; `module` is the file the bundle imports, which is the `.web.*` sibling when one
 * exists. They differ so a web override changes the code without moving the URL.
 */
export async function collectMobileWebAppRoutes(appDir, routeRoot = MOBILE_WEB_APP_ROUTE_ROOT) {
  const routes = []
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    const siblings = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name))
    for (const entry of entries) {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
      } else if (
        entry.isFile() &&
        ROUTE_FILE.test(entry.name) &&
        !NOT_A_ROUTE.test(entry.name) &&
        !entry.name.includes('.web.')
      ) {
        const override = webSiblingOf(entry.name, siblings)
        routes.push({
          key: `./${relative(appDir, entryPath).split('\\').join('/')}`,
          module: override ? join(directory, override) : entryPath
        })
      }
    }
  }
  await walk(join(appDir, routeRoot))
  if (routes.length === 0) {
    throw new Error(`[mobile-web-app] no routes under ${join(appDir, routeRoot)}`)
  }
  return routes.sort((left, right) => (left.key < right.key ? -1 : 1))
}

/** The require.context keys alone, for callers that only need the route names. */
export async function collectMobileWebAppRouteKeys(appDir, routeRoot = MOBILE_WEB_APP_ROUTE_ROOT) {
  return (await collectMobileWebAppRoutes(appDir, routeRoot)).map((route) => route.key)
}

/**
 * The RequireContext behaviour, kept as source so a test can evaluate it against a fake `modules`
 * without bundling the real route tree. Inlined into the generated module because that module is
 * bundled for the browser and cannot import from config/scripts.
 */
export const ROUTE_CONTEXT_SOURCE = `const keys = Object.keys(modules)
function routeContext(id) {
  if (!Object.prototype.hasOwnProperty.call(modules, id)) {
    throw new Error('[orca-mobile-web-app] no route module for ' + id)
  }
  return modules[id]
}
routeContext.keys = () => keys.slice()
routeContext.resolve = (id) => {
  if (!Object.prototype.hasOwnProperty.call(modules, id)) {
    throw new Error('[orca-mobile-web-app] cannot resolve route ' + id)
  }
  return id
}
routeContext.id = 'orca-mobile-web-app-routes'`

/**
 * esbuild has no `require.context`, so the builder synthesizes the RequireContext expo-router's
 * own ExpoRoot consumes. The context itself stays synchronous — expo-router reads `keys()` to
 * build the route tree before anything renders — and only the screen behind each key is deferred,
 * through the `import()` esbuild splits into a per-route chunk.
 *
 * `default` is the whole module: a lazy module cannot answer `unstable_settings` or
 * `ErrorBoundary`, which expo-router reads synchronously off the namespace. No route in the
 * mounted subtree exports either, and `assertRoutesCarryNoSynchronousExports` below fails the
 * build rather than emitting a page that mounts with the export silently gone.
 */
export function renderMobileWebAppRouteManifest(routes) {
  const entryLines = routes.map(
    ({ key, module }) =>
      `  [${JSON.stringify(key)}]: { default: lazy(() => import(${JSON.stringify(module)})) }`
  )
  return `import { lazy } from "react"
const modules = {
${entryLines.join(',\n')}
}
${ROUTE_CONTEXT_SOURCE}
export default routeContext
`
}

/**
 * The expo-router exports a route module may carry besides `default`. Read off the namespace while
 * the tree is built, so a lazy module would drop them silently rather than fail.
 */
export const ROUTE_MODULE_SYNCHRONOUS_EXPORTS = ['unstable_settings', 'ErrorBoundary']

/**
 * How esbuild has to read a route's own source. React Native ships untranspiled JSX inside `.js`,
 * including expo-router's own build/, so a `.js` route that carries JSX is a syntax error without
 * this. The builder spreads the same table into its own loaders, which is what keeps the guard
 * reading a route exactly as the bundle does.
 */
export const ROUTE_SOURCE_LOADERS = { '.js': 'jsx' }

/** esbuild's own normalized output for a re-export whose names it did not resolve. */
const STAR_REEXPORT = /^export \* from "(.*)";$/gm

/**
 * Which of those a route module puts on its namespace, and which specifiers it re-exports whole.
 *
 * Read from esbuild's parse rather than the source text, because the name reaching the namespace
 * is not the name any declaration carries: `export { settings as unstable_settings }`,
 * `export class ErrorBoundary` and `export { ErrorBoundary } from './boundary'` are all invisible
 * to a pattern over declarations, and all three break the lazy manifest the same way.
 *
 * `bundle` is off: this asks what one module exports, and following its imports would pull the
 * whole app in to answer. The cost is `export * from x`, whose names esbuild cannot enumerate
 * without reading x; those are returned separately so the caller fails closed instead of reading
 * an unresolved star as clean.
 */
export async function routeModuleSynchronousExports(modulePath) {
  const result = await esbuild.build({
    entryPoints: [modulePath],
    bundle: false,
    write: false,
    format: 'esm',
    metafile: true,
    loader: ROUTE_SOURCE_LOADERS,
    // Never written; it only names the single output the metafile is keyed by.
    outdir: 'route-exports',
    logLevel: 'silent'
  })
  const [output] = Object.values(result.metafile.outputs)
  return {
    named: (output?.exports ?? []).filter((name) =>
      ROUTE_MODULE_SYNCHRONOUS_EXPORTS.includes(name)
    ),
    starExports: [...result.outputFiles[0].text.matchAll(STAR_REEXPORT)].map((match) => match[1])
  }
}

/**
 * Fails the build on any route the lazy manifest would strip an export from. Runs in the build
 * and not only in a test, because what it prevents is a page that mounts with `ErrorBoundary`
 * gone: the throw escapes to the window, nothing paints, and no log says why.
 *
 * 14 parses of one module each, so it costs a fraction of the bundle it guards.
 */
export async function assertRoutesCarryNoSynchronousExports(routes) {
  const read = await Promise.all(routes.map(({ module }) => routeModuleSynchronousExports(module)))
  routes.forEach(({ key }, index) => {
    const { named, starExports } = read[index]
    if (named.length > 0) {
      throw new Error(
        `[mobile-web-app] ${key} exports ${named.join(', ')}, which expo-router reads off the ` +
          'module namespace while it builds the route tree. A route behind import() cannot answer ' +
          'it, so this route needs a static import or the export has to move to a layout.'
      )
    }
    if (starExports.length > 0) {
      throw new Error(
        `[mobile-web-app] ${key} re-exports all of ${starExports.join(', ')}, so whether it ` +
          `carries ${ROUTE_MODULE_SYNCHRONOUS_EXPORTS.join(' or ')} cannot be read without ` +
          'bundling it. Name the exports instead of re-exporting the module whole.'
      )
    }
  })
}
