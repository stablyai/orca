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
 * and 42 images, 18 routes are already allowed 98 chunks, and 98 + 42 + 1 is 141, so the asset
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
 *
 * This head reads 8,055,568 bytes of the 9,437,184 here, 85.4%, leaving 1,381,616. A reading and
 * not a pin: nothing asserts it, because the number moves with every build. It is here so the
 * generation that spends the rest can see it was already this close.
 */
export const MOBILE_WEB_APP_BUNDLE_MAX_TOTAL_BYTES = 9 * 1024 * 1024

/**
 * Scripts emitted at every prefix of the sorted route key list, and the route each prefix added.
 *
 * A chunk is emitted per distinct set of importers, not per route, so a route's marginal cost is
 * what it fails to share rather than what it weighs. Re-measured on this head by building
 * `routes.slice(0, n)` for every n, which is what the fence below is derived from rather than
 * fitted to. The spread it shows is 1 to 9: `pr` and `web` add one script each, `review` adds nine.
 *
 * This table is the fence's only input, so a route added to the tree stales it and the pins beside
 * the fence fail until it is re-measured. That is the point: the bound is re-derived, never bumped.
 */
export const MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP = [
  ['./h/[hostId]/[...page].tsx', 3],
  ['./h/[hostId]/accounts.tsx', 7],
  ['./h/[hostId]/agent-history/[worktreeId].tsx', 12],
  ['./h/[hostId]/edit.tsx', 17],
  ['./h/[hostId]/files/[worktreeId].tsx', 20],
  ['./h/[hostId]/files/preview/[worktreeId].tsx', 27],
  ['./h/[hostId]/history/[worktreeId].tsx', 29],
  ['./h/[hostId]/index.tsx', 34],
  ['./h/[hostId]/pr/[worktreeId].tsx', 35],
  ['./h/[hostId]/review/[worktreeId].tsx', 44],
  ['./h/[hostId]/session/[worktreeId].tsx', 52],
  ['./h/[hostId]/source-control/[worktreeId].tsx', 57],
  ['./h/[hostId]/tasks.tsx', 64],
  ['./h/[hostId]/web.tsx', 65],
  ['./h/_layout.tsx', 67]
]

const sweptScripts = MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP.map(([, scripts]) => scripts)

/** What each route after the first cost, which is the spread the envelope is an upper bound of. */
export const MOBILE_WEB_APP_BUNDLE_ROUTE_SCRIPT_SPREAD = sweptScripts
  .slice(1)
  .map((scripts, index) => scripts - sweptScripts[index])

/**
 * How far above the measurement the envelope sits, and the only slack a refactor gets.
 *
 * Measured, not chosen: the head that wrote the old `4r + 16` swept the same prefix lengths and
 * read 32, 43, 61 and 69 at 8, 10, 12 and 14 routes, where this head reads 34, 44, 57 and 65. So
 * four is the most the count has been seen to move at a fixed route count with no route added,
 * which is what a shared importer set moving between heads costs. A refactor inside that keeps
 * building; anything past it re-measures the sweep.
 */
export const MOBILE_WEB_APP_BUNDLE_SCRIPT_MARGIN = 4

/**
 * How many scripts the page may be cut into, for a given number of routes.
 *
 * Anchored on the sweep above rather than fitted to the route count, because the count is not a
 * function of the route count alone: `4r + 16` was a guess at break-even and its slack ran from 17
 * at one route to 4 at thirteen, so it was a near-miss exactly where the tree actually sits. This
 * is the measurement plus the margin at the swept tree, growing by the worst route the sweep saw
 * for every route past it — a route cannot breach it without costing more than any route measured.
 *
 * Flat below the swept length, which is the whole sweep's upper bound too: the count rises with the
 * prefix, so one number above its top row is above every row. The fence is only ever asked about
 * the real tree, and routes are only ever added.
 *
 * Two-sided in the test beside it. An envelope more than the margin above the build is a fence
 * nobody re-derived, and it fails there rather than surviving as headroom for a bump.
 *
 * The route count stays the only term. A deferred engine belongs inside one artifact and costs one
 * script: C7.10 item B first reached mermaid with `import('mermaid')`, which emitted 103 more
 * because mermaid lazily imports each of its own diagram types, and a second term admitting those
 * would have raised this fence far enough to admit any split at all. The build test's control is
 * what holds that line.
 *
 * This is the ceiling that catches a split running away; MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES
 * below is the one that catches it collapsing, and it is the real budget of the two.
 */
export function mobileWebAppBundleMaxChunks(routeCount) {
  const beyondTheSweep = Math.max(0, routeCount - MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP.length)
  return (
    sweptScripts.at(-1) +
    MOBILE_WEB_APP_BUNDLE_SCRIPT_MARGIN +
    Math.max(...MOBILE_WEB_APP_BUNDLE_ROUTE_SCRIPT_SPREAD) * beyondTheSweep
  )
}

/**
 * What the browser must parse before the first route can paint: the entry plus every chunk it
 * reaches by static import. This is the budget splitting exists to hold — it was 8.16 MB as one
 * chunk and measures 1,612,253 bytes split on this head, 1.54 of the 3 MiB — so a route
 * re-imported statically, or `splitting` dropped, fails the build here instead of arriving as a
 * slow first open on a phone.
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
 * extra assets, so a route count that pushes the chunk envelope plus images plus the document past
 * it would pass this build and fail on the device with nothing to read. At today's 42 images that
 * is 31 routes, inside what Phase C adds, which is why this is a build failure and not a comment.
 * The envelope grants the worst swept route to each one past the sweep, so re-measuring a tree
 * whose routes share more moves that crossing out again.
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
