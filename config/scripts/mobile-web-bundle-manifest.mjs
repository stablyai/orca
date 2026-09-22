import { createHash } from 'node:crypto'
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))

export const MOBILE_WEB_BUNDLE_SCHEMA_VERSION = 1
export const MOBILE_WEB_BUNDLE_ENTRYPOINT = 'index.html'

const CONTENT_TYPE_BY_EXTENSION = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
  // The app bundle emits images as same-origin assets rather than data: URLs, so each one is
  // content-hashed and served from here. Fonts are absent by design: the policy sets
  // font-src 'none'.
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

/**
 * Canonical serialization the buildId hashes. Key order is fixed and the list is sorted by path,
 * so the id is a pure function of content. Must stay byte-identical to the contract module's
 * serializer in src/shared/mobile-web-bundle/.
 */
export function serializeMobileWebBundleAssets(assets) {
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

export function computeMobileWebBundleBuildId(assets) {
  return createHash('sha256').update(serializeMobileWebBundleAssets(assets), 'utf8').digest('hex')
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function contentTypeForExtension(extension) {
  const contentType = CONTENT_TYPE_BY_EXTENSION[extension]
  if (!contentType) {
    throw new Error(`[mobile-web-bundle-manifest] no content type registered for .${extension}`)
  }
  return contentType
}

export function hashedAsset(bytes, extension) {
  const sha256 = sha256Hex(bytes)
  return {
    bytes,
    path: `assets/${sha256}.${extension}`,
    sha256,
    byteLength: bytes.byteLength,
    contentType: contentTypeForExtension(extension)
  }
}

function readIntegerConstant(source, name) {
  const match = new RegExp(`export const ${name} = (\\d+)`).exec(source)
  if (!match) {
    throw new Error(
      `[mobile-web-bundle-manifest] ${name} not found in src/shared/protocol-version.ts`
    )
  }
  return Number.parseInt(match[1], 10)
}

/**
 * Parsed rather than imported because protocol-version.ts is TypeScript and this script runs on
 * bare node during packaging, before any build output exists.
 */
export async function readProtocolWindow() {
  const source = await readFile(join(projectDir, 'src', 'shared', 'protocol-version.ts'), 'utf8')
  return {
    runtimeProtocolVersion: readIntegerConstant(source, 'RUNTIME_PROTOCOL_VERSION'),
    // The bundle is a client: the floor it cares about is the oldest host protocol it can talk to.
    minCompatibleRuntimeProtocolVersion: readIntegerConstant(
      source,
      'MIN_COMPATIBLE_RUNTIME_SERVER_VERSION'
    )
  }
}

export async function readDesktopVersion() {
  const packageJson = JSON.parse(await readFile(join(projectDir, 'package.json'), 'utf8'))
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error('[mobile-web-bundle-manifest] root package.json has no version')
  }
  return packageJson.version
}

/**
 * Manifest assembly and the on-disk write, kept apart from any one builder so the manifest shape
 * the contract module and the packaging guard read has a single producer.
 */
export async function writeMobileWebBundleTree({
  outDir,
  written,
  desktopVersion,
  protocolWindow,
  // Empty for a tree with no route list at all: a shell reading it finds no screen listed and
  // renders every route natively.
  routes = []
}) {
  const assets = written
    .map(({ path, sha256, byteLength, contentType }) => ({ path, sha256, byteLength, contentType }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const manifest = {
    schemaVersion: MOBILE_WEB_BUNDLE_SCHEMA_VERSION,
    buildId: computeMobileWebBundleBuildId(assets),
    desktopVersion,
    minCompatibleRuntimeProtocolVersion: protocolWindow.minCompatibleRuntimeProtocolVersion,
    runtimeProtocolVersion: protocolWindow.runtimeProtocolVersion,
    entrypoint: MOBILE_WEB_BUNDLE_ENTRYPOINT,
    totalBytes: assets.reduce((total, asset) => total + asset.byteLength, 0),
    assets,
    routes
  }

  // Why a full clear: a stale asset left from an earlier build would ship unreferenced inside asar.
  await rm(outDir, { recursive: true, force: true })
  await mkdir(join(outDir, 'assets'), { recursive: true })
  for (const asset of written) {
    await writeFile(join(outDir, asset.path), asset.bytes)
  }
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { manifest, outDir }
}
