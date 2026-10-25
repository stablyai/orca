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
const { assertNoDarkOutputOfOffSwitches } = createRequire(import.meta.url)(
  '../dark-build-switches.cjs'
)

// Require a fresh built page as beforePack does: an orcad package without it cannot serve phones.
export function stageOrcadMobileWebBundle(outputDir, bundleDir = MOBILE_WEB_BUNDLE_DIR) {
  // The release template refuses the variable itself.
  assertNoDarkOutputOfOffSwitches([bundleDir])
  assertMobileWebBundleBuilt(bundleDir)
  // The guard refuses unlisted files, so the tree is the manifest, its assets and a dark marker.
  cpSync(bundleDir, join(outputDir, ...ORCAD_MOBILE_WEB_DIR.split('/')), { recursive: true })
}

export function readOrcadMobileWebAssetFilenames(packageDir) {
  return orcadMobileWebAssetFilenames(
    readFileSync(join(packageDir, ...ORCAD_MOBILE_WEB_MANIFEST.split('/')), 'utf8')
  )
}
