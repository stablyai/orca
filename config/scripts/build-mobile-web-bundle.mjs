import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as esbuild from 'esbuild'

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const sourceDir = join(projectDir, 'src', 'mobile-web')
const defaultOutDir = join(projectDir, 'out', 'mobile-web')

export const MOBILE_WEB_BUNDLE_SCHEMA_VERSION = 1
export const MOBILE_WEB_BUNDLE_ENTRYPOINT = 'index.html'

const CONTENT_TYPE_BY_EXTENSION = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
  // The Phase C app bundle emits images as same-origin assets rather than data: URLs, so each one
  // is content-hashed and served from here. Fonts are absent by design: the policy sets
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
    throw new Error(`[build-mobile-web-bundle] no content type registered for .${extension}`)
  }
  return contentType
}

function readIntegerConstant(source, name) {
  const match = new RegExp(`export const ${name} = (\\d+)`).exec(source)
  if (!match) {
    throw new Error(`[build-mobile-web-bundle] ${name} not found in src/shared/protocol-version.ts`)
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
    throw new Error('[build-mobile-web-bundle] root package.json has no version')
  }
  return packageJson.version
}

async function transformEntries(protocolWindow, desktopVersion) {
  const result = await esbuild.build({
    absWorkingDir: sourceDir,
    entryPoints: [join(sourceDir, 'src', 'bootstrap.ts'), join(sourceDir, 'src', 'bootstrap.css')],
    bundle: true,
    minify: true,
    // Virtual: write is false, so outdir only names the emitted files esbuild hands back.
    outdir: 'dist',
    write: false,
    format: 'iife',
    target: ['es2022'],
    charset: 'utf8',
    legalComments: 'none',
    // Why no sourcemap and no metafile: both embed absolute paths, which would break reproducibility.
    sourcemap: false,
    logLevel: 'silent',
    define: {
      ORCA_MOBILE_WEB_DESKTOP_VERSION: JSON.stringify(desktopVersion),
      ORCA_MOBILE_WEB_RUNTIME_PROTOCOL_VERSION: JSON.stringify(
        protocolWindow.runtimeProtocolVersion
      ),
      ORCA_MOBILE_WEB_MIN_COMPATIBLE_RUNTIME_PROTOCOL_VERSION: JSON.stringify(
        protocolWindow.minCompatibleRuntimeProtocolVersion
      )
    }
  })
  const byExtension = new Map()
  for (const file of result.outputFiles) {
    const extension = file.path.endsWith('.css') ? 'css' : 'js'
    byExtension.set(extension, Buffer.from(file.contents))
  }
  const script = byExtension.get('js')
  const stylesheet = byExtension.get('css')
  if (!script || !stylesheet) {
    throw new Error('[build-mobile-web-bundle] esbuild did not emit both a script and a stylesheet')
  }
  return { script, stylesheet }
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

export async function buildMobileWebBundle({ outDir = defaultOutDir } = {}) {
  const [desktopVersion, protocolWindow] = await Promise.all([
    readDesktopVersion(),
    readProtocolWindow()
  ])
  const { script, stylesheet } = await transformEntries(protocolWindow, desktopVersion)
  const mark = await readFile(join(sourceDir, 'src', 'orca-mark.png'))

  const hashed = [
    hashedAsset(script, 'js'),
    hashedAsset(stylesheet, 'css'),
    hashedAsset(mark, 'png')
  ]
  const [scriptAsset, stylesheetAsset, markAsset] = hashed

  const template = await readFile(join(sourceDir, MOBILE_WEB_BUNDLE_ENTRYPOINT), 'utf8')
  const substitutions = {
    __ORCA_BOOTSTRAP_JS__: scriptAsset.path,
    __ORCA_BOOTSTRAP_CSS__: stylesheetAsset.path,
    __ORCA_MARK_PNG__: markAsset.path
  }
  let html = template
  for (const [token, value] of Object.entries(substitutions)) {
    if (!html.includes(token)) {
      throw new Error(`[build-mobile-web-bundle] ${MOBILE_WEB_BUNDLE_ENTRYPOINT} lacks ${token}`)
    }
    html = html.replaceAll(token, value)
  }
  const indexBytes = Buffer.from(html, 'utf8')
  const indexAsset = {
    bytes: indexBytes,
    path: MOBILE_WEB_BUNDLE_ENTRYPOINT,
    sha256: sha256Hex(indexBytes),
    byteLength: indexBytes.byteLength,
    contentType: contentTypeForExtension('html')
  }

  return writeMobileWebBundleTree({
    outDir,
    written: [indexAsset, ...hashed],
    desktopVersion,
    protocolWindow
  })
}

/**
 * Manifest assembly and the on-disk write, shared by the Phase A bootstrap bundle and the Phase C
 * app bundle so both produce the same manifest shape the contract module and verifier read.
 */
export async function writeMobileWebBundleTree({
  outDir,
  written,
  desktopVersion,
  protocolWindow,
  // Empty for the Phase A bootstrap, which carries no route tree at all: a shell reading it finds
  // no screen listed and renders every route natively, which is what it already does.
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

/**
 * Whether this module was run as the entry script. Two ways to get this wrong, both of which end
 * with the builder exiting 0 having written nothing: `file://${path}` never matches on Windows,
 * where import.meta.url is `file:///C:/...`; and Node resolves symlinks in import.meta.url but not
 * in argv[1], so `node /tmp/...` against a /private/tmp realpath compares two different strings.
 * Both seams are injectable so win32 and a missing path can be exercised from a posix runner.
 */
export function isDirectInvocation(
  moduleUrl,
  scriptPath,
  { toFileUrl = pathToFileURL, realpath = realpathSync } = {}
) {
  if (!scriptPath) {
    return false
  }
  let resolved = scriptPath
  try {
    resolved = realpath(scriptPath)
  } catch {
    // A path that cannot be resolved cannot be this module; fall through to the literal compare.
  }
  return moduleUrl === toFileUrl(resolved).href
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  const { manifest, outDir } = await buildMobileWebBundle()
  console.log(
    `[build-mobile-web-bundle] OK — ${String(manifest.assets.length)} asset(s), ` +
      `${String(manifest.totalBytes)} bytes, buildId ${manifest.buildId} -> ${outDir}`
  )
}
