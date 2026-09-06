import { createHash } from 'node:crypto'
import { readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { MOBILE_WEB_PACKAGE_BRIDGE_RANGE } from '../../src/shared/mobile-web/bridge-release-policy.ts'
import {
  MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
  MobileWebManifestSchema,
  serializeMobileWebManifestForBuildId
} from '../../src/shared/mobile-web/manifest-contract.ts'
import { mobileWebDocumentCsp } from '../../src/shared/mobile-web/document-csp.ts'
import { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH } from '../../src/shared/mobile-web/markdown-editor-csp.ts'
import {
  MOBILE_WEB_MERMAID_FRAME_PATH,
  buildMobileWebMermaidFrameDocument
} from '../../src/shared/mobile-web/mermaid-frame-document.ts'
import { colors } from '../../mobile/src/theme/mobile-theme.ts'
import { assertMobileWebRnwExecutablePolicy } from './mobile-web-rnw-executable-policy.mjs'

const args = parseArgs(process.argv.slice(2))
const inputRoot = path.resolve(args.input ?? 'out/mobile-web-rnw-export')
const outputRoot = path.resolve(args.output ?? 'out/mobile-web-rnw')
assertOutputRoot(outputRoot)

const sourceFiles = await listFiles(inputRoot)
const scriptSources = sourceFiles.filter((file) => file.endsWith('.js'))
const styleSources = sourceFiles.filter((file) => file.endsWith('.css'))
const binarySources = sourceFiles.filter((file) => /\.(png|svg|wasm|webp|woff2)$/.test(file))
if (scriptSources.length !== 1 || styleSources.length > 1) {
  throw new Error('RNW export must contain one script and at most one stylesheet')
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(path.join(outputRoot, 'assets'), { recursive: true })

const replacements = new Map()
const packaged = new Map()
for (const sourcePath of binarySources) {
  const bytes = await readFile(path.join(inputRoot, sourcePath))
  const packagedPath = contentAddressedPath(bytes, path.extname(sourcePath))
  replacementsForSource(replacements, sourcePath, packagedPath)
  packaged.set(packagedPath, bytes)
}

let style = `${webResetStyles()}\n`
if (styleSources[0]) {
  style += await readFile(path.join(inputRoot, styleSources[0]), 'utf8')
}
style = replaceReferences(style, replacements)
const styleBytes = Buffer.from(style)
const stylePath = contentAddressedPath(styleBytes, '.css')
if (styleSources[0]) {
  replacementsForSource(replacements, styleSources[0], stylePath)
}
packaged.set(stylePath, styleBytes)

let script = await readFile(path.join(inputRoot, scriptSources[0]), 'utf8')
script = replaceReferences(script, replacements)
script = disableRuntimeCodeGeneration(script)
assertSafeExecutable(script)
assertNoExportAssetReferences(script, sourceFiles)
const scriptBytes = Buffer.from(script)
const scriptPath = contentAddressedPath(scriptBytes, '.js')
packaged.set(scriptPath, scriptBytes)

const document = mobileWebDocument({ scriptPath, stylePath })
const documentBytes = Buffer.from(document)
packaged.set('index.html', documentBytes)
const mermaidFrame = buildMobileWebMermaidFrameDocument({
  theme: {
    background: colors.bgRaised,
    primary: colors.bgPanel,
    text: colors.textPrimary,
    line: colors.textSecondary
  }
})
packaged.set(MOBILE_WEB_MERMAID_FRAME_PATH, Buffer.from(mermaidFrame))

for (const [assetPath, bytes] of packaged) {
  await mkdir(path.dirname(path.join(outputRoot, assetPath)), { recursive: true })
  await writeFile(path.join(outputRoot, assetPath), bytes)
}

const assets = [...packaged]
  .map(([assetPath, bytes]) => manifestAsset(assetPath, bytes))
  .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
const manifestWithoutIdentity = {
  schemaVersion: MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
  buildId: '0'.repeat(64),
  bridge: MOBILE_WEB_PACKAGE_BRIDGE_RANGE,
  entrypoint: 'index.html',
  totalBytes: assets.reduce((total, asset) => total + asset.byteLength, 0),
  assets
}
const manifest = MobileWebManifestSchema.parse({
  ...manifestWithoutIdentity,
  buildId: sha256(serializeMobileWebManifestForBuildId(manifestWithoutIdentity))
})
await writeFile(path.join(outputRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(
  `RNW mobile web package: ${manifest.assets.length} assets, ${manifest.totalBytes} bytes, build ${manifest.buildId}`
)

function disableRuntimeCodeGeneration(source) {
  const rewrites = [
    {
      pattern: /eval\('require'\)\('node:crypto'\)\.randomUUID\(\)/g,
      replacement: 'crypto.randomUUID()',
      expected: 1
    },
    {
      pattern: /return eval\(body\)/g,
      replacement: "throw new Error('Runtime split bundles are disabled')",
      expected: 1
    },
    {
      pattern: /return new Function\(""\),!0/g,
      replacement: 'return!1',
      expected: 1
    }
  ]
  let output = source
  for (const rewrite of rewrites) {
    const matches = output.match(rewrite.pattern)?.length ?? 0
    if (matches !== rewrite.expected) {
      throw new Error(`Unexpected RNW runtime code-generation shape: ${rewrite.pattern}`)
    }
    output = output.replace(rewrite.pattern, rewrite.replacement)
  }
  return output
}

function assertSafeExecutable(source) {
  assertMobileWebRnwExecutablePolicy(source)
}

function assertNoExportAssetReferences(source, sourceFiles) {
  for (const sourcePath of sourceFiles) {
    if (
      source.includes(`/${sourcePath}`) ||
      source.includes(`./${sourcePath}`) ||
      source.includes(sourcePath)
    ) {
      throw new Error(`RNW executable retains an unhashed export path: ${sourcePath}`)
    }
  }
  if (/["']\/(?:assets|_expo)\//.test(source)) {
    throw new Error('RNW executable retains an absolute asset path')
  }
}

function replacementsForSource(replacements, sourcePath, packagedPath) {
  replacements.set(`/${sourcePath}`, `./${packagedPath}`)
  replacements.set(`./${sourcePath}`, `./${packagedPath}`)
  replacements.set(sourcePath, packagedPath)
}

function replaceReferences(source, replacements) {
  let output = source
  const ordered = [...replacements].sort(([left], [right]) => right.length - left.length)
  for (const [from, to] of ordered) {
    output = output.replaceAll(from, to)
  }
  return output
}

function mobileWebDocument({ scriptPath, stylePath }) {
  const csp = mobileWebDocumentCsp(MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,shrink-to-fit=no,viewport-fit=cover">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <title>Orca</title>
    <link rel="stylesheet" href="./${stylePath}">
  </head>
  <body>
    <noscript>You need to enable JavaScript to run this app.</noscript>
    <div id="root"></div>
    <script src="./${scriptPath}" defer></script>
  </body>
</html>
`
}

function webResetStyles() {
  return 'html,body,#root{height:100%;margin:0}body{overflow:hidden}#root{display:flex;flex:1}button,[role="button"]{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}'
}

function manifestAsset(assetPath, bytes) {
  const extension = path.extname(assetPath)
  const definitions = {
    '.css': ['text/css; charset=utf-8', 'style'],
    '.html': ['text/html; charset=utf-8', 'document'],
    '.js': ['text/javascript; charset=utf-8', 'script'],
    '.png': ['image/png', 'image'],
    '.svg': ['image/svg+xml; charset=utf-8', 'image'],
    '.wasm': ['application/wasm', 'wasm'],
    '.webp': ['image/webp', 'image'],
    '.woff2': ['font/woff2', 'font']
  }
  const definition = definitions[extension]
  if (!definition) {
    throw new Error(`Unsupported RNW package asset: ${assetPath}`)
  }
  return {
    path: assetPath,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    contentType: definition[0],
    role: definition[1]
  }
}

function contentAddressedPath(bytes, extension) {
  return `assets/${sha256(bytes)}${extension}`
}

function assertOutputRoot(candidate) {
  const relative = path.relative(path.resolve('out'), candidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('RNW package output must be a child of out/')
  }
}

async function listFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const child = relative ? path.join(relative, entry.name) : entry.name
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, child)))
    } else if (child !== 'metadata.json' && child !== 'index.html') {
      files.push(child.split(path.sep).join('/'))
    }
  }
  return files.sort()
}

function parseArgs(values) {
  const result = {}
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index]
    if (key === '--input' || key === '--output') {
      result[key.slice(2)] = values[++index]
    }
  }
  return result
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
