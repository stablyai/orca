import { readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import * as esbuild from 'esbuild'

/** The route subtree the page mounts. The rest of mobile/app is native-only (pairing, settings). */
export const MOBILE_WEB_APP_ROUTE_ROOT = 'h'

const ROUTE_FILE = /\.[tj]sx?$/
const NOT_A_ROUTE = /(\.(test|spec|d)\.|\+api\.|\+middleware\.)/
// Full-path imports bypass esbuild resolveExtensions, so select web sibling explicitly.
const WEB_SIBLING_EXTENSIONS = ['.web.tsx', '.web.ts', '.web.jsx', '.web.js']

function webSiblingOf(name, siblings) {
  const stem = name.slice(0, name.length - extname(name).length)
  return WEB_SIBLING_EXTENSIONS.map((extension) => `${stem}${extension}`).find((candidate) =>
    siblings.has(candidate)
  )
}

// Sort require.context keys deterministically; keys retain native filenames/URLs while modules select web siblings.
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
  const rootLayout = await pageRootLayout(appDir)
  return (rootLayout ? [...routes, rootLayout] : routes).sort((left, right) =>
    left.key < right.key ? -1 : 1
  )
}

// Require web root layout: native owns pairing/push; absent override mounts DefaultNavigator’s all-edge SafeAreaView.
async function pageRootLayout(appDir) {
  const entries = await readdir(appDir, { withFileTypes: true })
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name))
  const override = files.has(ROOT_LAYOUT) ? webSiblingOf(ROOT_LAYOUT, files) : undefined
  return override ? { key: `./${ROOT_LAYOUT}`, module: join(appDir, override) } : null
}

const ROOT_LAYOUT = '_layout.tsx'

// Preserve [dynamic] segments as shell-match patterns; index names directory and _ files are layouts.
export function routePathnameFromKey(key) {
  const segments = key.replace(/^\.\//, '').replace(ROUTE_FILE, '').split('/')
  const last = segments.at(-1)
  if (last === undefined || last.startsWith('_')) {
    return null
  }
  if (last === 'index') {
    segments.pop()
  }
  return `/${segments.join('/')}`
}

export async function collectMobileWebAppRouteKeys(appDir, routeRoot = MOBILE_WEB_APP_ROUTE_ROOT) {
  return (await collectMobileWebAppRoutes(appDir, routeRoot)).map((route) => route.key)
}

// Inline context behavior as source: browser bundle cannot import config/scripts; tests can evaluate against fake modules.
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

// ExpoRoot needs synchronous keys to build tree; defer only route modules through split import().
// Lazy default hides synchronous unstable_settings/ErrorBoundary exports; assertRoutesCarryNoSynchronousExports fails build if any route adds them.
export function renderMobileWebAppRouteManifest(routes) {
  const entryLines = routes.map(({ key, module }) => {
    // Layout can commit behind pending screen chunk, so it cannot signal paint.
    // Closure-only manifest entries lack keys and are never loaded; wrapping their screens is optional.
    const resolved = key?.endsWith('/_layout.tsx')
      ? `import(${JSON.stringify(module)})`
      : `import(${JSON.stringify(module)}).then(withRouteScreenPaintReport)`
    return `  [${JSON.stringify(key)}]: { default: lazy(() => ${resolved}) }`
  })
  return `import { lazy } from "react"
import { withRouteScreenPaintReport } from "./src/mobile-web-shell/bridge/page-first-paint"
const modules = {
${entryLines.join(',\n')}
}
${ROUTE_CONTEXT_SOURCE}
export default routeContext
`
}

// Expo-router reads these namespace exports synchronously; lazy modules would silently drop them.
export const ROUTE_MODULE_SYNCHRONOUS_EXPORTS = ['unstable_settings', 'ErrorBoundary']

// Share JSX-in-.js loader with builder: RN/expo-router ship untranspiled JSX, and guard must parse exactly what bundle accepts.
export const ROUTE_SOURCE_LOADERS = { '.js': 'jsx' }

const STAR_REEXPORT = /^export \* from "(.*)";$/gm

// Parse export namespace, not declarations: aliases/classes/reexports can expose synchronous route exports.
// Do not bundle entire app to inspect one module; unresolved export * fails closed instead of appearing clean.
export async function routeModuleSynchronousExports(modulePath) {
  const result = await esbuild.build({
    entryPoints: [modulePath],
    bundle: false,
    write: false,
    format: 'esm',
    metafile: true,
    loader: ROUTE_SOURCE_LOADERS,
    // Virtual output name only; never written to disk.
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

// Enforce during build too: stripping ErrorBoundary from lazy route could yield unreported blank page.
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
