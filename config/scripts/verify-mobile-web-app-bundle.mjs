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

/**
 * The document, the route chunks and the images the route tree imports. Was 64 while the bundle
 * was one script: splitting the 14 routes emits 53 chunks, because esbuild gives every distinct
 * set of importers its own shared chunk. Measured at 96, held under the native map's own 256
 * (MOBILE_WEB_SHELL_MAX_ASSETS) so the ceiling that trips first is this one, and above what
 * mobileWebAppBundleMaxChunks allows so the chunk ceiling is the one that names the problem.
 */
export const MOBILE_WEB_APP_BUNDLE_MAX_ASSETS = 128

/**
 * Phase C byte budget for the app bundle, not the contract ceiling (10 MiB per asset,
 * MOBILE_WEB_BUNDLE_MAX_ASSET_BYTES). Deliberately below it so growth trips a build rather than a
 * refused asset on a phone. Splitting barely moves it — the same code is emitted in more files —
 * so shrinking this still means cutting code.
 */
export const MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES = 9 * 1024 * 1024

/**
 * How many scripts the page may be cut into, for a given number of routes. A chunk is emitted per
 * distinct set of importers rather than per route, so the count is combinatorial in what the
 * routes share: 8 routes measure 23 chunks, 10 measure 40, 12 measure 47, 14 measure 53, about
 * three more per route at the top. Four per route with a flat 16 leaves the next few routes room,
 * so a route added in C2 fails on its own weight and not on a number measured before it existed.
 *
 * This is the ceiling that catches a split running away; MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES
 * below is the one that catches it collapsing, and it is the real budget of the two.
 */
export function mobileWebAppBundleMaxChunks(routeCount) {
  return 4 * routeCount + 16
}

/**
 * What the browser must parse before the first route can paint: the entry plus every chunk it
 * reaches by static import. This is the budget splitting exists to hold — it was 8.16 MB as one
 * chunk and measures 0.89 MiB split — so a route re-imported statically, or `splitting` dropped,
 * fails the build here instead of arriving as a slow first open on a phone.
 *
 * It is not a per-route escape hatch. Importing one route statically already breaks this bound
 * for 5 of the 14: session at 7.16 MiB, tasks 5.91, source-control 5.78, review 5.77,
 * files/preview 5.21. What keeps the hatch usable at all is that expo-router reads
 * `unstable_settings` off layout nodes only, and the subtree's one layout, `h/_layout.tsx`,
 * measures 2.22 MiB static. Any other route needing a synchronous export needs this number
 * re-measured, not a static import.
 */
export const MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES = 3 * 1024 * 1024

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
    return await buildMobileWebAppBundle({ outDir: join(scratch, 'mobile-web-app') })
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
  if (first.manifest.buildId !== second.manifest.buildId) {
    fail(`buildId is not reproducible: ${first.manifest.buildId} then ${second.manifest.buildId}`)
  }
  if (first.manifest.buildId !== manifest.buildId) {
    fail(
      `${bundleDir} is stale: it carries buildId ${manifest.buildId}, a fresh build produces ${first.manifest.buildId}`
    )
  }
  // Read off the fresh build rather than the manifest: neither bound is a manifest field, and the
  // buildId just proved this build is the one on disk.
  const maxChunks = mobileWebAppBundleMaxChunks(first.routeKeys.length)
  if (first.chunkCount > maxChunks) {
    fail(
      `bundle is cut into ${String(first.chunkCount)} chunks, over the Phase C budget of ` +
        `${String(maxChunks)} for ${String(first.routeKeys.length)} route(s)`
    )
  }
  if (first.entryStaticBytes > MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES) {
    fail(
      `${String(first.entryStaticBytes)} bytes load before the first route, over the Phase C ` +
        `budget of ${String(MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES)}`
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
