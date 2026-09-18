import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMobileWebBundle } from './build-mobile-web-bundle.mjs'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const bundleDir = join(projectDir, 'out', 'mobile-web')

// Phase A budget, not the contract ceiling: a bootstrap page past a quarter-megabyte has stopped
// being a bootstrap. Phase C raises these deliberately.
export const MOBILE_WEB_BUNDLE_PHASE_A_MAX_ASSETS = 16
export const MOBILE_WEB_BUNDLE_PHASE_A_MAX_TOTAL_BYTES = 256 * 1024

function fail(message) {
  console.error(`[verify-mobile-web-bundle] ${message}`)
  process.exit(1)
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

async function readBundledManifest() {
  try {
    return JSON.parse(await readFile(join(bundleDir, 'manifest.json'), 'utf8'))
  } catch (error) {
    fail(
      `cannot read ${join(bundleDir, 'manifest.json')} (${error instanceof Error ? error.message : String(error)}). ` +
        'Run pnpm build:mobile-web.'
    )
  }
}

const manifest = await readBundledManifest()

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

for (const asset of manifest.assets) {
  let bytes
  try {
    bytes = await readFile(join(bundleDir, asset.path))
  } catch {
    fail(`manifest lists ${asset.path}, which is missing from ${bundleDir}`)
  }
  if (bytes.byteLength !== asset.byteLength) {
    fail(
      `${asset.path} is ${String(bytes.byteLength)} bytes, manifest says ${String(asset.byteLength)}`
    )
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== asset.sha256) {
    fail(`${asset.path} hashes to ${sha256}, manifest says ${asset.sha256}`)
  }
}

// Two fresh builds into scratch dirs: a timestamp, an absolute path, or an unstable ordering
// anywhere in the pipeline shows up here as a buildId mismatch rather than as a phone cache miss.
const [first, second] = [await buildIntoScratch(), await buildIntoScratch()]
if (first.buildId !== second.buildId) {
  fail(`buildId is not reproducible: ${first.buildId} then ${second.buildId}`)
}
if (first.buildId !== manifest.buildId) {
  fail(
    `${bundleDir} is stale: it carries buildId ${manifest.buildId}, a fresh build produces ${first.buildId}`
  )
}

console.log(
  `[verify-mobile-web-bundle] OK — ${String(manifest.assets.length)} asset(s), ` +
    `${String(manifest.totalBytes)}/${String(MOBILE_WEB_BUNDLE_PHASE_A_MAX_TOTAL_BYTES)} bytes, ` +
    `reproducible buildId ${manifest.buildId}`
)
