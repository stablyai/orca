import { cpSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  ORCAD_MOBILE_WEB_DIR,
  ORCAD_MOBILE_WEB_MANIFEST,
  orcadMobileWebAssetFilenames
} from '../../src/shared/orcad-artifacts.ts'

const { MOBILE_WEB_BUNDLE_DIR, assertMobileWebBundleBuilt } = createRequire(import.meta.url)(
  './verify-packaged-mobile-web-bundle.cjs'
)

/**
 * The built page (pnpm build:mobile-web) into an orcad package. Fatal when it is missing or stale,
 * as electron-builder's beforePack is: a server without it serves phones no page.
 */
export function stageOrcadMobileWebBundle(outputDir, bundleDir = MOBILE_WEB_BUNDLE_DIR) {
  assertMobileWebBundleBuilt(bundleDir)
  // The guard refuses unlisted files, so the tree is exactly the manifest and its assets.
  cpSync(bundleDir, join(outputDir, ...ORCAD_MOBILE_WEB_DIR.split('/')), { recursive: true })
}

/** The asset half of a package's artifact list, read from the page it carries. */
export function readOrcadMobileWebAssetFilenames(packageDir) {
  return orcadMobileWebAssetFilenames(
    readFileSync(join(packageDir, ...ORCAD_MOBILE_WEB_MANIFEST.split('/')), 'utf8')
  )
}
