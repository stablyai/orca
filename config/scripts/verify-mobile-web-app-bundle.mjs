import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { isDirectInvocation } from './build-mobile-web-bundle.mjs'
import { assertNoCarriageReturnsInSource } from './verify-mobile-web-bundle.mjs'
import { assertMobileWebBundleBuilt } from './verify-packaged-mobile-web-bundle.cjs'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const defaultBundleDir = join(projectDir, 'out', 'mobile-web-app')

/** One script, one document, and the images the route tree imports. */
export const MOBILE_WEB_APP_BUNDLE_MAX_ASSETS = 64

/**
 * Phase C byte budget for the app bundle, not the contract ceiling (10 MiB per asset,
 * MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES). Deliberately below it so growth trips a build rather than a
 * refused asset on a phone. esbuild `splitting` does not help a single entry with only static
 * imports — it emits one chunk — so shrinking this means cutting code, not re-chunking.
 */
export const MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES = 9 * 1024 * 1024

/** Every tree whose bytes reach the buildId, so a CRLF checkout cannot fork it. */
export const MOBILE_WEB_APP_SOURCE_DIRS = [
  join(projectDir, 'mobile', 'web-entry'),
  join(projectDir, 'mobile', 'app'),
  join(projectDir, 'mobile', 'src')
]

class VerificationError extends Error {}

function fail(message) {
  throw new VerificationError(message)
}

async function buildIntoScratch() {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-verify-'))
  try {
    const { manifest } = await buildMobileWebAppBundle({ outDir: join(scratch, 'mobile-web-app') })
    return manifest
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

// bundleDir is a seam for the tests, which verify a scratch build; the script always verifies out/.
export async function verifyMobileWebAppBundle({ bundleDir = defaultBundleDir } = {}) {
  for (const directory of MOBILE_WEB_APP_SOURCE_DIRS) {
    await assertNoCarriageReturnsInSource(directory)
  }

  const manifest = assertMobileWebBundleBuilt(bundleDir)

  if (manifest.assets.length > MOBILE_WEB_APP_BUNDLE_MAX_ASSETS) {
    fail(
      `bundle has ${String(manifest.assets.length)} assets, over the Phase C budget of ` +
        `${String(MOBILE_WEB_APP_BUNDLE_MAX_ASSETS)}`
    )
  }
  if (manifest.totalBytes > MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES) {
    fail(
      `bundle is ${String(manifest.totalBytes)} bytes, over the Phase C budget of ` +
        `${String(MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES)}`
    )
  }

  const first = await buildIntoScratch()
  const second = await buildIntoScratch()
  if (first.buildId !== second.buildId) {
    fail(`buildId is not reproducible: ${first.buildId} then ${second.buildId}`)
  }
  if (first.buildId !== manifest.buildId) {
    fail(
      `${bundleDir} is stale: it carries buildId ${manifest.buildId}, a fresh build produces ${first.buildId}`
    )
  }
  return manifest
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  try {
    const manifest = await verifyMobileWebAppBundle()
    console.log(
      `[verify-mobile-web-app-bundle] OK — ${String(manifest.assets.length)} asset(s), ` +
        `${String(manifest.totalBytes)}/${String(MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES)} bytes, ` +
        `reproducible buildId ${manifest.buildId}`
    )
  } catch (error) {
    console.error(`[verify-mobile-web-app-bundle] ${error.message}`)
    process.exit(1)
  }
}
