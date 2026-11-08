// Prints MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP: the shipped build of each sorted route prefix.
import { fileURLToPath } from 'node:url'
import { collectMobileWebAppRoutes } from '../../mobile-web-app/mobile-web-app-route-manifest.mjs'
import { buildMobileWebAppScripts, pageScriptCount } from './build-mobile-web-app-bundle.mjs'

const routes = await collectMobileWebAppRoutes(
  fileURLToPath(new URL('../../../../mobile/app', import.meta.url))
)
for (let count = 1; count <= routes.length; count++) {
  const { metafile } = await buildMobileWebAppScripts(routes.slice(0, count))
  console.log(`  ['${routes[count - 1].key}', ${String(pageScriptCount(metafile))}],`)
}
