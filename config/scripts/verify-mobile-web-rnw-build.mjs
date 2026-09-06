import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  MobileWebManifestSchema,
  serializeMobileWebManifestForBuildId
} from '../../src/shared/mobile-web/manifest-contract.ts'
import { mobileWebDocumentCspDirectives } from '../../src/shared/mobile-web/document-csp.ts'
import { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH } from '../../src/shared/mobile-web/markdown-editor-csp.ts'
import {
  MOBILE_WEB_MERMAID_FRAME_PATH,
  MOBILE_WEB_MERMAID_FRAME_SCRIPT,
  mobileWebMermaidFrameCspDirectives
} from '../../src/shared/mobile-web/mermaid-frame-document.ts'
import {
  MOBILE_WEB_RNW_BUILD_BUDGET,
  mobileWebRnwBuildBudgetFailures
} from './mobile-web-rnw-build-budget.mjs'
import { mobileWebRnwExecutablePolicyFailure } from './mobile-web-rnw-executable-policy.mjs'
const outputRoot = path.resolve(parseOutputRoot(process.argv.slice(2)))
const manifestPath = path.join(outputRoot, 'manifest.json')
const manifest = MobileWebManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))

const expectedBuildId = sha256(serializeMobileWebManifestForBuildId(manifest))
if (manifest.buildId !== expectedBuildId) {
  throw new Error('RNW manifest buildId does not match canonical manifest content')
}

const assetBytes = new Map()
for (const asset of manifest.assets) {
  const bytes = await readFile(path.join(outputRoot, ...asset.path.split('/')))
  assetBytes.set(asset.path, bytes)
  if (bytes.byteLength !== asset.byteLength) {
    throw new Error(`RNW asset length mismatch: ${asset.path}`)
  }
  if (sha256(bytes) !== asset.sha256) {
    throw new Error(`RNW asset hash mismatch: ${asset.path}`)
  }
  if (asset.role !== 'document' && !contentAddressMatches(asset.path, asset.sha256)) {
    throw new Error(`RNW asset path is not content-addressed: ${asset.path}`)
  }
}

const roles = countRoles(manifest.assets)
if (roles.document !== 2 || roles.script !== 1 || roles.style > 1) {
  throw new Error('RNW package must contain two documents, one script, and at most one style')
}

const scriptBytes = bytesForRole(manifest.assets, 'script')
const styleBytes = bytesForRole(manifest.assets, 'style')
const compressedBytes = manifest.assets.reduce(
  (total, asset) => total + gzipSync(assetBytes.get(asset.path), { level: 9 }).byteLength,
  0
)
const measurement = {
  assets: manifest.assets.length,
  compressedBytes,
  scriptBytes,
  styleBytes,
  totalBytes: manifest.totalBytes
}
if (mobileWebRnwBuildBudgetFailures(measurement).length > 0) {
  throw new Error(
    [
      'RNW mobile web bundle exceeds budget:',
      `assets=${measurement.assets}/${MOBILE_WEB_RNW_BUILD_BUDGET.assets}`,
      `total=${measurement.totalBytes}/${MOBILE_WEB_RNW_BUILD_BUDGET.totalBytes}`,
      `compressed=${measurement.compressedBytes}/${MOBILE_WEB_RNW_BUILD_BUDGET.compressedBytes}`,
      `script=${measurement.scriptBytes}/${MOBILE_WEB_RNW_BUILD_BUDGET.scriptBytes}`,
      `style=${measurement.styleBytes}/${MOBILE_WEB_RNW_BUILD_BUDGET.styleBytes}`
    ].join(' ')
  )
}

const actualPaths = (await listFiles(outputRoot)).filter((file) => file !== 'manifest.json').sort()
const declaredPaths = manifest.assets.map((asset) => asset.path)
if (JSON.stringify(actualPaths) !== JSON.stringify(declaredPaths)) {
  throw new Error('RNW output contains undeclared or missing assets')
}

const html = await readFile(path.join(outputRoot, manifest.entrypoint), 'utf8')
if (!/<meta\s+name=["']viewport["'][^>]*\bviewport-fit=cover\b/i.test(html)) {
  throw new Error('RNW document must expose native safe-area insets')
}
for (const directive of mobileWebDocumentCspDirectives(
  MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH
)) {
  if (!html.includes(directive)) {
    throw new Error(`RNW CSP is missing: ${directive}`)
  }
}
if (/<style(?:\s|>)/i.test(html) || /<script(?!\s+src=)/i.test(html)) {
  throw new Error('RNW document contains inline executable or stylesheet content')
}
for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
  const reference = match[1]
  if (!reference?.startsWith('./assets/')) {
    throw new Error(`RNW document contains a non-relative asset reference: ${reference}`)
  }
  if (!declaredPaths.includes(reference.slice(2))) {
    throw new Error(`RNW document references an undeclared asset: ${reference}`)
  }
}

const mermaidFrame = await readFile(path.join(outputRoot, MOBILE_WEB_MERMAID_FRAME_PATH), 'utf8')
for (const directive of mobileWebMermaidFrameCspDirectives()) {
  if (!mermaidFrame.includes(directive)) {
    throw new Error(`RNW Mermaid frame CSP is missing: ${directive}`)
  }
}
const mermaidScripts = [
  ...mermaidFrame.matchAll(/<script(?<attributes>[^>]*)>(?<source>[\s\S]*?)<\/script>/gi)
]
if (
  mermaidScripts.length !== 1 ||
  mermaidScripts[0]?.groups?.attributes?.trim() !== '' ||
  mermaidScripts[0]?.groups?.source !== MOBILE_WEB_MERMAID_FRAME_SCRIPT
) {
  throw new Error('RNW Mermaid frame must contain only the fixed inline renderer')
}
if (/\b(?:src|href)=["']/i.test(mermaidFrame)) {
  throw new Error('RNW Mermaid frame must not reference external resources')
}
const mermaidPolicyFailure = mobileWebRnwExecutablePolicyFailure(MOBILE_WEB_MERMAID_FRAME_SCRIPT)
if (mermaidPolicyFailure) {
  throw new Error(`RNW Mermaid frame contains ${mermaidPolicyFailure}`)
}

for (const asset of manifest.assets.filter((candidate) => candidate.role === 'script')) {
  const source = assetBytes.get(asset.path).toString('utf8')
  const executablePolicyFailure = mobileWebRnwExecutablePolicyFailure(source)
  if (executablePolicyFailure) {
    throw new Error(`RNW executable contains ${executablePolicyFailure}: ${asset.path}`)
  }
  for (const symbol of [
    'NATIVE_MOBILE_PR_SHELL_OPERATIONS',
    'NATIVE_HOST_SOURCE_CONTROL_FEEDBACK',
    'NATIVE_HOST_DIFF_REVIEW_DEVICE_OPERATIONS',
    'ProtocolBlockScreen',
    'navigator.clipboard',
    'ClipboardPasteButton',
    'launchImageLibraryAsync',
    'getDocumentAsync',
    'ImageManipulator'
  ]) {
    if (source.includes(symbol)) {
      throw new Error(`RNW executable contains native fallback authority: ${symbol}`)
    }
  }
}

console.log(
  [
    `RNW mobile web build verified: ${manifest.assets.length} assets`,
    `${manifest.totalBytes} bytes`,
    `(${compressedBytes} gzip)`,
    `build ${manifest.buildId}`
  ].join(', ')
)

function bytesForRole(assets, role) {
  return assets
    .filter((asset) => asset.role === role)
    .reduce((total, asset) => total + asset.byteLength, 0)
}

function contentAddressMatches(assetPath, expectedHash) {
  const parsed = path.posix.parse(assetPath)
  return parsed.dir === 'assets' && parsed.name === expectedHash
}

function countRoles(assets) {
  return assets.reduce((counts, asset) => {
    counts[asset.role] = (counts[asset.role] ?? 0) + 1
    return counts
  }, {})
}

async function listFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = relative ? path.join(relative, entry.name) : entry.name
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, child)))
    } else {
      files.push(child.split(path.sep).join('/'))
    }
  }
  return files
}

function parseOutputRoot(values) {
  const rootIndex = values.indexOf('--root')
  if (rootIndex === -1) {
    return 'out/mobile-web-rnw'
  }
  const root = values[rootIndex + 1]
  if (!root) {
    throw new Error('--root requires a package directory')
  }
  return root
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
