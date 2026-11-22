import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { buildMobileWebAppBundle } from './build-mobile-web-app-bundle.mjs'
import { isDirectInvocation } from '../../tool-invocation/script-entry-detection.mjs'
import { assertNoCarriageReturnsInSource } from './mobile-web-source-line-endings.mjs'
import { contentAssetName } from './mobile-web-bundle-manifest.mjs'
import {
  MOBILE_WEB_BUNDLE_DIR as defaultBundleDir,
  assertMobileWebBundleBuilt
} from '../../desktop-distribution/runtime-verification/verify-packaged-mobile-web-bundle.cjs'
import { MOBILE_WEB_BUNDLE_ENTRYPOINT, sha256Hex } from './mobile-web-bundle-manifest.mjs'

const projectDir = fileURLToPath(new URL('../../../..', import.meta.url))
const manifestContract = join(
  projectDir,
  'src',
  'shared',
  'mobile-web-bundle',
  'manifest-contract.ts'
)

// Derive asset ceiling as chunks+images+document so chunk overflow reports splitting cause before generic count; flat ceiling drifts as routes grow.
export function mobileWebAppBundleMaxAssets(routeCount, imageCount, catalogChunkCount = 0) {
  return mobileWebAppBundleMaxChunks(routeCount) + catalogChunkCount + imageCount + 1
}

// UI-language catalogs have their own allowance, like the font: one chunk per non-English locale,
// fetched only for the active language, never before the first route. Code keeps its own fence.
export const MOBILE_WEB_APP_BUNDLE_MAX_CATALOG_CHUNKS = 10
export const MOBILE_WEB_APP_BUNDLE_MAX_CATALOG_BYTES = 3 * 1024 * 1024
// The host sends a catalog's JSON in one reply, which must fit a 1 MiB relay frame once encrypted.
export const MOBILE_WEB_APP_HOST_CATALOG_MAX_BYTES = 384 * 1024

// Our own fence on the page's code, well inside the phone contract (32 MiB total, 10 MiB per asset in
// manifest-contract.ts); routes are split and the entry is capped below, so no one asset nears 10 MiB.
// Split by startup cost vs assets loaded on use: the eager budget holds everything the page may load
// to open (all code, fonts outside the terminal allowance, images the document names); the on-demand
// budget holds only files outfitSheetsOnDemand proves are fetched when used, and any that the document
// names count as eager. The phone shell still downloads each on-demand file to disk once per bundle
// update (shellDownloadedAssets), so this budget also bounds that download.
// Eager: main's own fence. 10.90625 MiB since a size pass took the page to 11,252,196 bytes (2026-11-22).
export const MOBILE_WEB_APP_BUNDLE_MAX_EAGER_BYTES = 10.90625 * 1024 * 1024
export const MOBILE_WEB_APP_BUNDLE_MAX_ON_DEMAND_BYTES = 1024 * 1024
export const MOBILE_WEB_APP_BUNDLE_MAX_ON_DEMAND_FILE_BYTES = 128 * 1024

const OUTFIT_SHEET_DIR = join(projectDir, 'src', 'shared', 'bot-mascots', 'outfits')

// Each outfit's sheet ships as its own image, fetched only when a picture wears that outfit, never
// inlined in code. Returns the sheets the page document never names, so a page with no outfits loads none.
export async function outfitSheetsOnDemand(manifest, bundleDir) {
  const document = await readFile(join(bundleDir, MOBILE_WEB_BUNDLE_ENTRYPOINT), 'utf8')
  const sheets = (await readdir(OUTFIT_SHEET_DIR)).filter((name) => name.endsWith('.webp'))
  const onDemand = []
  for (const name of sheets) {
    const file = contentAssetName(sha256Hex(await readFile(join(OUTFIT_SHEET_DIR, name))), 'webp')
    const asset = manifest.assets.find((entry) => entry.path === `assets/${file}`)
    if (!asset) {
      fail(`outfit sheet ${name} is not its own image in the bundle, so it was inlined or dropped`)
    }
    if (!document.includes(file)) {
      onDemand.push({ name, byteLength: asset.byteLength })
    }
  }
  return onDemand
}

export function assertOnDemandFits(onDemand) {
  const tooBig = onDemand.find(
    (file) => file.byteLength > MOBILE_WEB_APP_BUNDLE_MAX_ON_DEMAND_FILE_BYTES
  )
  if (tooBig) {
    fail(
      `on-demand file ${tooBig.name} is ${String(tooBig.byteLength)} bytes, over the per-file budget of ` +
        `${String(MOBILE_WEB_APP_BUNDLE_MAX_ON_DEMAND_FILE_BYTES)}`
    )
  }
  const bytes = onDemand.reduce((total, file) => total + file.byteLength, 0)
  if (bytes > MOBILE_WEB_APP_BUNDLE_MAX_ON_DEMAND_BYTES) {
    fail(
      `on-demand files are ${String(bytes)} bytes, over the budget of ${String(MOBILE_WEB_APP_BUNDLE_MAX_ON_DEMAND_BYTES)}`
    )
  }
  return bytes
}

// Only these licensed terminal fonts have their own allowance; other fonts (KaTeX's) and code count.
// The page fetches each only when the terminal draws with it, so none weighs on first open.
export const MOBILE_WEB_APP_TERMINAL_FONT_MAX_BYTES = 1300 * 1024
const APPROVED_TERMINAL_FONTS = [
  // Symbols Nerd Font Mono, identical to desktop's.
  ['8efa6ba89f0a1f3eefde028f36aa64a13e36282e15ea0ca6929c664501037467', 1_177_916],
  // The terminal font setting's JetBrains Mono, Fira Code and Geist Mono, latin and latin-ext.
  ['18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e', 40_404],
  ['79bfdab9ba467e26eea4122e6f2567e188dd8a09a8c730d501fc487c4ab99c6e', 15_196],
  ['771bf4b79a97fc005d12866168bd39d868a9dd3d5903008fe8b796723c8a56f4', 36_276],
  ['801677342d1191c5e964719bbcb5834f5da3c39a00e1e1501f450b1379fcc116', 13_272],
  ['684ad5b531f81d43c1e8c7038262d5db7cdc1f68006e04d6c7769efa8d33c8cc', 23_128],
  ['1a189eb997c3e2ece68373e387afaec9e8617424186c4b1ab3cff7c54ba6223b', 14_696]
]

export function mobileWebAppBundleBudgetBytes(manifest) {
  const fontBytes = manifest.assets
    .filter((asset) =>
      APPROVED_TERMINAL_FONTS.some(
        ([sha256, byteLength]) =>
          asset.path === `assets/${contentAssetName(sha256, 'woff2')}` &&
          asset.sha256 === sha256 &&
          asset.contentType === 'font/woff2' &&
          asset.byteLength === byteLength
      )
    )
    .reduce((total, asset) => total + asset.byteLength, 0)
  return manifest.totalBytes - (fontBytes <= MOBILE_WEB_APP_TERMINAL_FONT_MAX_BYTES ? fontBytes : 0)
}

// Measure sorted route prefixes with routes.slice(0,n), excluding locale catalogs: distinct importer sets determine chunks, not route count.
// Re-measure table with measure-mobile-web-app-chunk-sweep.mjs when routes change; it is envelope’s only input, and pins must fail rather than permit arbitrary ceiling bumps.
export const MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP = [
  ['./_layout.tsx', 4],
  ['./h/[hostId]/[...page].tsx', 6],
  ['./h/[hostId]/accounts.tsx', 7],
  ['./h/[hostId]/agent-history/[worktreeId].tsx', 9],
  ['./h/[hostId]/automations.tsx', 13],
  ['./h/[hostId]/edit.tsx', 14],
  ['./h/[hostId]/files/[worktreeId].tsx', 18],
  ['./h/[hostId]/files/preview/[worktreeId].tsx', 22],
  ['./h/[hostId]/group/[groupId].tsx', 29],
  ['./h/[hostId]/history/[worktreeId].tsx', 30],
  ['./h/[hostId]/index.tsx', 38],
  ['./h/[hostId]/new-workspace.tsx', 43],
  ['./h/[hostId]/pr/[worktreeId].tsx', 44],
  ['./h/[hostId]/review/[worktreeId].tsx', 54],
  ['./h/[hostId]/session/[worktreeId].tsx', 77],
  ['./h/[hostId]/source-control/[worktreeId].tsx', 79],
  ['./h/[hostId]/tasks.tsx', 86],
  ['./h/_layout.tsx', 90]
]

const sweptScripts = MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP.map(([, scripts]) => scripts)

// Marginal script cost per added route defines measured envelope’s worst-case slope.
export const MOBILE_WEB_APP_BUNDLE_ROUTE_SCRIPT_SPREAD = sweptScripts
  .slice(1)
  .map((scripts, index) => scripts - sweptScripts[index])

// Allow four chunks of measured refactor-only drift per head, never cumulative; larger change requires fresh sweep rather than inflated margin.
export const MOBILE_WEB_APP_BUNDLE_SCRIPT_MARGIN = 4

// Ceiling is swept maximum+margin, flat below sweep length, growing by worst measured route beyond it; test both excess and unused headroom.
// Route count remains sole term: deferred engine must be one artifact, not admit mermaid’s 103 diagram chunks through a new allowance. Entry closure budget below catches collapsed splitting.
export function mobileWebAppBundleMaxChunks(routeCount) {
  const beyondTheSweep = Math.max(0, routeCount - MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP.length)
  return (
    sweptScripts.at(-1) +
    MOBILE_WEB_APP_BUNDLE_SCRIPT_MARGIN +
    Math.max(...MOBILE_WEB_APP_BUNDLE_ROUTE_SCRIPT_SPREAD) * beyondTheSweep
  )
}

// Bound entry/static-import closure before first paint: dropping splitting or statically importing a route can ship slow first-open.
// Expo-router needs synchronous unstable_settings only on layouts; re-measure budget before making another route static, not as a per-route escape hatch.
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

// Load phone’s manifest asset ceiling from contract through esbuild, which resolves extensionless TS imports; never copy native shell count.
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

// Reject derived asset allowance beyond phone’s map limit: shells reject whole oversized manifest, not just extras; re-sweep shared routes to tighten envelope.
export function assertAssetCeilingFitsShell(
  routeCount,
  imageCount,
  shellMaxAssets,
  catalogChunkCount = 0
) {
  const ceiling = mobileWebAppBundleMaxAssets(routeCount, imageCount, catalogChunkCount)
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
    return await buildMobileWebAppBundle({ outDir: join(scratch, 'mobile-web') })
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
  if (
    first.catalogChunkCount > MOBILE_WEB_APP_BUNDLE_MAX_CATALOG_CHUNKS ||
    first.catalogBytes > MOBILE_WEB_APP_BUNDLE_MAX_CATALOG_BYTES
  ) {
    fail(
      `${String(first.catalogChunkCount)} locale catalog chunk(s) of ${String(first.catalogBytes)} bytes exceed ` +
        `the catalog allowance of ${String(MOBILE_WEB_APP_BUNDLE_MAX_CATALOG_CHUNKS)} chunks and ` +
        `${String(MOBILE_WEB_APP_BUNDLE_MAX_CATALOG_BYTES)} bytes`
    )
  }
  // buildId leaves the host's JSON catalogs out, so a stale copy shows only here.
  const hostCatalogsOf = (built) => JSON.stringify(built.catalogs ?? [])
  if (hostCatalogsOf(first.manifest) !== hostCatalogsOf(second.manifest)) {
    fail('host language catalogs are not reproducible')
  }
  if (hostCatalogsOf(first.manifest) !== hostCatalogsOf(manifest)) {
    fail(`${bundleDir} is stale: its host language catalogs differ from a fresh build's`)
  }
  const oversized = (manifest.catalogs ?? []).find(
    (catalog) => catalog.byteLength > MOBILE_WEB_APP_HOST_CATALOG_MAX_BYTES
  )
  if (oversized) {
    fail(
      `the ${oversized.locale} host catalog is ${String(oversized.byteLength)} bytes, over the ` +
        `${String(MOBILE_WEB_APP_HOST_CATALOG_MAX_BYTES)} one reply carries`
    )
  }
  const onDemandBytes = assertOnDemandFits(await outfitSheetsOnDemand(manifest, bundleDir))
  const eagerBytes = mobileWebAppBundleBudgetBytes(manifest) - first.catalogBytes - onDemandBytes
  if (eagerBytes > MOBILE_WEB_APP_BUNDLE_MAX_EAGER_BYTES) {
    fail(
      `bundle excluding the approved fonts, locale catalogs and on-demand files is ${String(eagerBytes)} bytes, ` +
        `over the Phase C eager budget of ${String(MOBILE_WEB_APP_BUNDLE_MAX_EAGER_BYTES)}`
    )
  }
  // Read chunk/entry bounds and image count from fresh verified build: they are not manifest fields, while buildId binds on-disk bytes.
  const maxAssets = assertAssetCeilingFitsShell(
    first.routeKeys.length,
    first.imageCount,
    await readMobileWebBundleMaxAssets(),
    first.catalogChunkCount
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
        `${String(maxChunks)} for ${String(first.routeKeys.length)} route(s); ` +
        'measure-mobile-web-app-chunk-sweep.mjs re-measures MOBILE_WEB_APP_BUNDLE_SCRIPT_SWEEP'
    )
  }
  if (first.entryStaticBytes > MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES) {
    fail(
      `${String(first.entryStaticBytes)} bytes load before the first route, over the Phase C ` +
        `budget of ${String(MOBILE_WEB_APP_BUNDLE_MAX_ENTRY_BYTES)}`
    )
  }
  return { ...manifest, catalogBytes: first.catalogBytes, eagerBytes, onDemandBytes }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  try {
    const manifest = await verifyMobileWebAppBundle()
    console.log(
      `[verify-mobile-web-app-bundle] OK — ${String(manifest.assets.length)} asset(s), ` +
        `${String(manifest.totalBytes)} total bytes, ` +
        `${String(manifest.eagerBytes)}/${String(MOBILE_WEB_APP_BUNDLE_MAX_EAGER_BYTES)} eager bytes excluding the approved fonts, ` +
        `${String(manifest.onDemandBytes)}/${String(MOBILE_WEB_APP_BUNDLE_MAX_ON_DEMAND_BYTES)} on-demand bytes, ` +
        `${String(manifest.catalogBytes)}/${String(MOBILE_WEB_APP_BUNDLE_MAX_CATALOG_BYTES)} bytes of language catalogs, ` +
        `reproducible buildId ${manifest.buildId}`
    )
  } catch (error) {
    console.error(`[verify-mobile-web-app-bundle] ${error.message}`)
    process.exit(1)
  }
}
