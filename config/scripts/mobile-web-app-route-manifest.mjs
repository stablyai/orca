import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'

/** The route subtree the page mounts. The rest of mobile/app is native-only (pairing, settings). */
export const MOBILE_WEB_APP_ROUTE_ROOT = 'h'

const ROUTE_FILE = /\.[tj]sx?$/
const NOT_A_ROUTE = /(\.(test|spec|d)\.|\+api\.|\+middleware\.)/

/**
 * require.context keys for the mounted subtree, relative to mobile/app and sorted, so the
 * generated module is a pure function of the tree on disk.
 */
export async function collectMobileWebAppRouteKeys(appDir, routeRoot = MOBILE_WEB_APP_ROUTE_ROOT) {
  const keys = []
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
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
        keys.push(`./${relative(appDir, entryPath).split('\\').join('/')}`)
      }
    }
  }
  await walk(join(appDir, routeRoot))
  if (keys.length === 0) {
    throw new Error(`[mobile-web-app] no routes under ${join(appDir, routeRoot)}`)
  }
  return keys.sort()
}

/**
 * esbuild has no `require.context`, so the builder synthesizes the RequireContext expo-router's
 * own ExpoRoot consumes: a callable with keys()/resolve()/id over statically imported routes.
 * Static imports, not a lazy getter — one bundle, no chunk fetch behind the page's CSP.
 */
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
export function renderMobileWebAppRouteManifest(appDir, keys) {
  const importLines = keys.map(
    (key, index) =>
      `import * as route${String(index)} from ${JSON.stringify(join(appDir, key.slice(2)))}`
  )
  const entryLines = keys.map((key, index) => `  [${JSON.stringify(key)}]: route${String(index)}`)
  return `${importLines.join('\n')}
const modules = {
${entryLines.join(',\n')}
}
${ROUTE_CONTEXT_SOURCE}
export default routeContext
`
}
