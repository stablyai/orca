import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  MOBILE_WEB_EMBEDDED_DOCUMENT_PATHS,
  MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
  serializeMobileWebManifestForBuildId
} from '../../src/shared/mobile-web/manifest-contract'

const [MOBILE_WEB_MARKDOWN_EDITOR_PATH, MOBILE_WEB_MERMAID_FRAME_PATH] =
  MOBILE_WEB_EMBEDDED_DOCUMENT_PATHS

export async function createPackagedCliResourceFixture(resourcesDir) {
  const cliDir = join(resourcesDir, 'app.asar.unpacked', 'out', 'cli')
  await mkdir(join(cliDir, 'handlers'), { recursive: true })
  await writeFile(join(cliDir, 'handlers', 'skills.js'), '', 'utf8')
  await writeFile(
    join(cliDir, 'index.js'),
    [
      'const args = process.argv.slice(2)',
      "if (args[1] === 'list') console.log(JSON.stringify({ topics: [{ name: 'orca-cli' }, { name: 'computer-use' }] }))",
      "else if (args[1] === 'get') console.log(`---\\nname: ${args[2]}\\n---`)",
      'else console.log(JSON.stringify({ executed: false }))'
    ].join('\n'),
    'utf8'
  )
}

export async function createMobileWebResourceFixture(resourcesDir) {
  const root = join(resourcesDir, 'mobile-web')
  const scripts = ['globalThis.__orcaPackagedMobileWeb=true', 'void 0', 'void 1'].map((source) => {
    const bytes = Buffer.from(source, 'utf8')
    const hash = sha256(bytes)
    return { bytes, hash, path: `assets/${hash}.js` }
  })
  const [entryScript, mermaidScript, editorScript] = scripts
  const document = Buffer.from(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><script src="./${entryScript.path}" defer></script>`,
    'utf8'
  )
  const mermaidFrame = Buffer.from(
    `<!doctype html><html><body><script src="./${mermaidScript.path}"></script></body></html>`,
    'utf8'
  )
  const markdownEditor = Buffer.from(
    `<!doctype html><html><body><script src="./${editorScript.path}"></script></body></html>`,
    'utf8'
  )
  const assets = [
    ...scripts.map((entry) => ({
      path: entry.path,
      sha256: entry.hash,
      byteLength: entry.bytes.byteLength,
      contentType: 'text/javascript; charset=utf-8',
      role: 'script'
    })),
    {
      path: 'index.html',
      sha256: sha256(document),
      byteLength: document.byteLength,
      contentType: 'text/html; charset=utf-8',
      role: 'document'
    },
    {
      path: MOBILE_WEB_MARKDOWN_EDITOR_PATH,
      sha256: sha256(markdownEditor),
      byteLength: markdownEditor.byteLength,
      contentType: 'text/html; charset=utf-8',
      role: 'document'
    },
    {
      path: MOBILE_WEB_MERMAID_FRAME_PATH,
      sha256: sha256(mermaidFrame),
      byteLength: mermaidFrame.byteLength,
      contentType: 'text/html; charset=utf-8',
      role: 'document'
    }
  ]
  assets.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const seed = {
    schemaVersion: MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
    buildId: '0'.repeat(64),
    bridge: { minimum: 2, testedThrough: 2 },
    entrypoint: 'index.html',
    totalBytes: assets.reduce((total, asset) => total + asset.byteLength, 0),
    assets
  }
  const manifest = { ...seed, buildId: sha256(serializeMobileWebManifestForBuildId(seed)) }
  await mkdir(join(root, 'assets'), { recursive: true })
  for (const entry of scripts) {
    await writeFile(join(root, entry.path), entry.bytes)
  }
  await writeFile(join(root, 'index.html'), document)
  await writeFile(join(root, MOBILE_WEB_MARKDOWN_EDITOR_PATH), markdownEditor)
  await writeFile(join(root, MOBILE_WEB_MERMAID_FRAME_PATH), mermaidFrame)
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
