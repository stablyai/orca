// Prints MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP for verify-mobile-web-app-bundle.mjs: the shipped build of each sorted route prefix.
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectMobileWebAppRoutes } from '../../mobile-web-app/mobile-web-app-route-manifest.mjs'
import { buildMobileWebAppScripts, localeCatalogOutputs } from './build-mobile-web-app-bundle.mjs'

const routes = await collectMobileWebAppRoutes(
  fileURLToPath(new URL('../../../../mobile/app', import.meta.url))
)
for (let count = 1; count <= routes.length; count++) {
  const { metafile } = await buildMobileWebAppScripts(routes.slice(0, count))
  const catalogs = localeCatalogOutputs(metafile)
  const scripts = Object.keys(metafile.outputs).filter(
    (output) => output.endsWith('.js') && !catalogs.has(basename(output))
  ).length
  console.log(`  ['${routes[count - 1].key}', ${String(scripts)}],`)
}
