import { readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

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
 * own ExpoRoot consumes. Static imports, not a lazy getter: one chunk, no fetch behind the
 * page's CSP.
 */
export function renderMobileWebAppRouteManifest(routes) {
  const importLines = routes.map(
    ({ module }, index) => `import * as route${String(index)} from ${JSON.stringify(module)}`
  )
  const entryLines = routes.map(
    ({ key }, index) => `  [${JSON.stringify(key)}]: route${String(index)}`
  )
  return `${importLines.join('\n')}
const modules = {
${entryLines.join(',\n')}
}
${ROUTE_CONTEXT_SOURCE}
export default routeContext
`
}
