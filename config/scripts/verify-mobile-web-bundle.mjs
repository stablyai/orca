import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMobileWebBundle, isDirectInvocation } from './build-mobile-web-bundle.mjs'
import { assertMobileWebBundleBuilt } from './verify-packaged-mobile-web-bundle.cjs'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const bundleDir = join(projectDir, 'out', 'mobile-web')
const sourceDir = join(projectDir, 'src', 'mobile-web')

// Phase A budget, not the contract ceiling: a bootstrap page past a quarter-megabyte has stopped
// being a bootstrap. Phase C raises these deliberately.
export const MOBILE_WEB_BUNDLE_PHASE_A_MAX_ASSETS = 16
export const MOBILE_WEB_BUNDLE_PHASE_A_MAX_TOTAL_BYTES = 256 * 1024

class VerificationError extends Error {}

function fail(message) {
  throw new VerificationError(message)
}

async function buildIntoScratch() {
  const scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-verify-'))
  try {
    const { manifest } = await buildMobileWebBundle({ outDir: join(scratch, 'mobile-web') })
    return manifest
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(entryPath)))
    } else if (entry.isFile()) {
      files.push(entryPath)
    }
  }
  return files.sort()
}

/**
 * Pinned `-text` in .gitattributes and skipped below, because a 0x0d in them means nothing. .svg
 * is absent on purpose: it is text, so the eol=lf pin applies and a CRLF .svg forks the buildId.
 * A test keeps this list and the .gitattributes exemptions in step.
 */
export const BINARY_SOURCE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2'
]

/**
 * A CRLF checkout changes the bytes of every text source, which changes every asset hash and so
 * the buildId. .gitattributes pins eol=lf; this is what notices when that pin stops working.
 */
export async function assertNoCarriageReturnsInSource(directory = sourceDir) {
  const offenders = []
  for (const file of await listSourceFiles(directory)) {
    if (BINARY_SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))) {
      continue
    }
    // Written by mobile's postinstall, gitignored, so no eol pin applies and none is needed.
    if (file.endsWith('.generated.ts')) {
      continue
    }
    if ((await readFile(file)).includes(0x0d)) {
      offenders.push(file.slice(directory.length + 1))
    }
  }
  if (offenders.length > 0) {
    fail(
      `CRLF in mobile web source, which would change every asset hash and the buildId: ` +
        `${offenders.join(', ')}. Check the .gitattributes eol=lf pin for ${directory}.`
    )
  }
}

export async function verifyMobileWebBundle() {
  await assertNoCarriageReturnsInSource()

  // The packaging guard owns manifest integrity (safe paths, recomputed buildId, totalBytes, hashes,
  // no stray files); a manifest edited after the build fails here exactly as it would at beforePack.
  const manifest = assertMobileWebBundleBuilt(bundleDir)

  if (manifest.assets.length > MOBILE_WEB_BUNDLE_PHASE_A_MAX_ASSETS) {
    fail(
      `bundle has ${String(manifest.assets.length)} assets, over the Phase A budget of ` +
        `${String(MOBILE_WEB_BUNDLE_PHASE_A_MAX_ASSETS)}`
    )
  }
  if (manifest.totalBytes > MOBILE_WEB_BUNDLE_PHASE_A_MAX_TOTAL_BYTES) {
    fail(
      `bundle is ${String(manifest.totalBytes)} bytes, over the Phase A budget of ` +
        `${String(MOBILE_WEB_BUNDLE_PHASE_A_MAX_TOTAL_BYTES)}`
    )
  }

  // Two fresh builds into scratch dirs: a timestamp, an absolute path, or an unstable ordering
  // anywhere in the pipeline shows up here as a buildId mismatch rather than as a phone cache miss.
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
    const manifest = await verifyMobileWebBundle()
    console.log(
      `[verify-mobile-web-bundle] OK — ${String(manifest.assets.length)} asset(s), ` +
        `${String(manifest.totalBytes)}/${String(MOBILE_WEB_BUNDLE_PHASE_A_MAX_TOTAL_BYTES)} bytes, ` +
        `reproducible buildId ${manifest.buildId}`
    )
  } catch (error) {
    console.error(`[verify-mobile-web-bundle] ${error.message}`)
    process.exit(1)
  }
}
