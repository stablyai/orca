const { createHash } = require('node:crypto')
const { readFileSync, readdirSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')

const projectDir = resolve(__dirname, '..', '..')
const MOBILE_WEB_BUNDLE_DIR = join(projectDir, 'out', 'mobile-web')
const REMEDY = 'Run pnpm build:mobile-web (build:desktop and build:release already do).'
const ENTRYPOINT = 'index.html'
const SHA256_PATTERN = /^[0-9a-f]{64}$/

function failure(message) {
  return new Error(`[verify-packaged-mobile-web-bundle] ${message}`)
}

function assertSafeRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0) {
    throw failure('manifest asset has a missing or empty path')
  }
  const segments = path.split('/')
  if (
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[a-zA-Z]:/.test(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw failure(`manifest asset path is not a safe relative path: ${path}`)
  }
}

function assertInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure(`manifest field ${field} is not a non-negative integer: ${String(value)}`)
  }
}

/**
 * Canonical serialization of the asset list. Must stay byte-identical to
 * serializeMobileWebBundleAssets in config/scripts/mobile-web-bundle-manifest.mjs; a divergence here
 * would reject every honest bundle, so the two move together.
 */
function serializeAssets(assets) {
  return JSON.stringify(
    [...assets]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map(({ path, sha256, byteLength, contentType }) => ({
        path,
        sha256,
        byteLength,
        contentType
      }))
  )
}

function parseManifest(bundleDir) {
  const manifestPath = join(bundleDir, 'manifest.json')
  let raw
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    throw failure(
      `no bundle manifest at ${manifestPath} (${error.code ?? error.message}). ${REMEDY}`
    )
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    throw failure(`${manifestPath} is not valid JSON: ${error.message}. ${REMEDY}`)
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw failure(`${manifestPath} is not a JSON object. ${REMEDY}`)
  }
  if (manifest.schemaVersion !== 1) {
    throw failure(`unsupported manifest schemaVersion: ${String(manifest.schemaVersion)}`)
  }
  if (typeof manifest.buildId !== 'string' || !SHA256_PATTERN.test(manifest.buildId)) {
    throw failure(`manifest buildId is not a sha256 digest: ${String(manifest.buildId)}`)
  }
  if (typeof manifest.desktopVersion !== 'string' || manifest.desktopVersion.length === 0) {
    throw failure('manifest desktopVersion is missing')
  }
  assertInteger(manifest.minCompatibleRuntimeProtocolVersion, 'minCompatibleRuntimeProtocolVersion')
  assertInteger(manifest.runtimeProtocolVersion, 'runtimeProtocolVersion')
  assertInteger(manifest.totalBytes, 'totalBytes')
  if (manifest.entrypoint !== ENTRYPOINT) {
    throw failure(`manifest entrypoint must be ${ENTRYPOINT}, got ${String(manifest.entrypoint)}`)
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw failure('manifest lists no assets')
  }
  for (const asset of manifest.assets) {
    if (typeof asset !== 'object' || asset === null) {
      throw failure('manifest asset entry is not an object')
    }
    assertSafeRelativePath(asset.path)
    if (typeof asset.sha256 !== 'string' || !SHA256_PATTERN.test(asset.sha256)) {
      throw failure(`manifest asset ${asset.path} has no sha256 digest`)
    }
    assertInteger(asset.byteLength, `assets[${asset.path}].byteLength`)
    if (typeof asset.contentType !== 'string' || asset.contentType.length === 0) {
      throw failure(`manifest asset ${asset.path} has no contentType`)
    }
  }
  if (!manifest.assets.some((asset) => asset.path === manifest.entrypoint)) {
    throw failure(`manifest entrypoint ${manifest.entrypoint} is not one of its assets`)
  }
  const declaredTotal = manifest.assets.reduce((total, asset) => total + asset.byteLength, 0)
  if (declaredTotal !== manifest.totalBytes) {
    throw failure(
      `manifest totalBytes is ${String(manifest.totalBytes)}, its assets sum to ${String(declaredTotal)}`
    )
  }
  const recomputed = createHash('sha256')
    .update(serializeAssets(manifest.assets), 'utf8')
    .digest('hex')
  if (recomputed !== manifest.buildId) {
    throw failure(
      `manifest buildId ${manifest.buildId} does not match its asset list (expected ${recomputed}). ${REMEDY}`
    )
  }
  return manifest
}

/** Every file under the bundle directory, as a manifest-shaped relative path. */
function listBundleFiles(directory, prefix = '') {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...listBundleFiles(join(directory, entry.name), relativePath))
    } else {
      found.push(relativePath)
    }
  }
  return found
}

/**
 * Nothing in the bundle directory may be unaccounted for. An asset dropped from the manifest but
 * left on disk by an interrupted build ships inside asar, unreachable and unverified, and grows
 * the installer; content-addressed names mean stale copies never get overwritten.
 */
function assertNoUnlistedFiles(bundleDir, manifest) {
  const listed = new Set(['manifest.json', ...manifest.assets.map((asset) => asset.path)])
  const strays = listBundleFiles(bundleDir).filter((path) => !listed.has(path))
  if (strays.length > 0) {
    throw failure(
      `${bundleDir} holds ${String(strays.length)} file(s) the manifest does not list: ` +
        `${strays.sort().join(', ')}. ${REMEDY}`
    )
  }
}

/**
 * Packaging guard: electron-builder only warns about a missing input, so without this a release
 * would ship an app that advertises the bundle capability and then errors on every request. The
 * hash check, not the existence check, is what catches a half-written or stale out/.
 */
function assertMobileWebBundleBuilt(bundleDir = MOBILE_WEB_BUNDLE_DIR) {
  const manifest = parseManifest(bundleDir)
  assertNoUnlistedFiles(bundleDir, manifest)
  for (const asset of manifest.assets) {
    const assetPath = join(bundleDir, asset.path)
    let size
    try {
      size = statSync(assetPath).size
    } catch (error) {
      throw failure(
        `manifest lists ${asset.path}, which is missing from ${bundleDir} (${error.code ?? error.message}). ${REMEDY}`
      )
    }
    if (size !== asset.byteLength) {
      throw failure(
        `${asset.path} is ${String(size)} bytes on disk, manifest says ${String(asset.byteLength)}. ${REMEDY}`
      )
    }
    const sha256 = createHash('sha256').update(readFileSync(assetPath)).digest('hex')
    if (sha256 !== asset.sha256) {
      throw failure(
        `${asset.path} hashes to ${sha256} on disk, manifest says ${asset.sha256}. ${REMEDY}`
      )
    }
  }
  console.log(
    `[verify-packaged-mobile-web-bundle] OK — buildId ${manifest.buildId}, ` +
      `${String(manifest.assets.length)} asset(s), ${String(manifest.totalBytes)} bytes`
  )
  return manifest
}

// serializeAssets is exported for the parity test that pins it against the builder's and the
// contract's serializers; nothing in packaging calls it from outside this module.
module.exports = { MOBILE_WEB_BUNDLE_DIR, assertMobileWebBundleBuilt, serializeAssets }
