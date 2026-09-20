import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { isDirectInvocation } from './build-mobile-web-bundle.mjs'
import { assertNoCarriageReturnsInSource } from './verify-mobile-web-bundle.mjs'
import { assertMobileWebBundleBuilt } from './verify-packaged-mobile-web-bundle.cjs'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const defaultBundleDir = join(projectDir, 'out', 'mobile-web-app')
const manifestContract = join(
  projectDir,
  'src',
  'shared',
  'mobile-web-bundle',
  'manifest-contract.ts'
)

/**
 * The document, the route chunks and the images the route tree imports. Derived rather than
 * pinned, because a flat number stops agreeing with the chunk ceiling as routes are added: at 128
 * and 42 images, 18 routes are already allowed 88 chunks, and 88 + 42 + 1 is 131, so the asset
 * count would have failed first and named the count rather than the split that caused it. Written
 * as chunks + images + the document, a bundle at the chunk ceiling sits exactly at this one, so
 * the chunk ceiling always trips first and the failure says what actually grew.
 */
export function mobileWebAppBundleMaxAssets(routeCount, imageCount) {
  return mobileWebAppBundleMaxChunks(routeCount) + imageCount + 1
}

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

/**
 * How many assets the phone will accept, read from the contract rather than copied: the native
 * shells hold their own 256 and refuse a larger manifest outright. Bundled through esbuild
 * because node cannot resolve that module's extensionless TypeScript imports, so the number is
 * evaluated from the contract and not parsed out of it.
 */
export async function readMobileWebBundleMaxAssets() {
  const { outputFiles } = await esbuild.build({
    entryPoints: [manifestContract],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  const source = Buffer.from(outputFiles[0].contents).toString('base64')
  const { MOBILE_WEB_BUNDLE_MAX_ASSETS: ceiling } = await import(
    `data:text/javascript;base64,${source}`
  )
  if (typeof ceiling !== 'number') {
    fail(`${manifestContract} exports no MOBILE_WEB_BUNDLE_MAX_ASSETS to bound the build with`)
  }
  return ceiling
}

/**
 * The derived ceiling is only a budget while it stays inside the map the phone can hold: the
 * shells return null for a manifest over MOBILE_WEB_BUNDLE_MAX_ASSETS rather than dropping the
 * extra assets, so a route count that pushes 4r + 16 + images + 1 past it would pass this build
 * and fail on the device with nothing to read. At today's 42 images that is 50 routes, inside
 * what Phase C adds, which is why this is a build failure and not a comment.
 */
export function assertAssetCeilingFitsShell(routeCount, imageCount, shellMaxAssets) {
  const ceiling = mobileWebAppBundleMaxAssets(routeCount, imageCount)
  if (ceiling > shellMaxAssets) {
    fail(
      `the ceiling derived for ${String(routeCount)} route(s) and ${String(imageCount)} image(s) ` +
        `is ${String(ceiling)} assets, over the ${String(shellMaxAssets)} the shell will load`
    )
  }
  return ceiling
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
  // After the fresh build, which is what knows how many of the assets are images.
  const maxAssets = assertAssetCeilingFitsShell(
    first.routeKeys.length,
    first.imageCount,
    await readMobileWebBundleMaxAssets()
  )
  if (manifest.assets.length > maxAssets) {
    fail(
      `bundle has ${String(manifest.assets.length)} assets, over the Phase C budget of ` +
        `${String(maxAssets)} for ${String(first.routeKeys.length)} route(s) and ` +
        `${String(first.imageCount)} image(s)`
    )
  }
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
