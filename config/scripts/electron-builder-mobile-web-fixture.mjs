import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mobileWebDocumentCsp } from '../../src/shared/mobile-web/document-csp'
import { MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH } from '../../src/shared/mobile-web/markdown-editor-csp'
import {
  MOBILE_WEB_MERMAID_FRAME_PATH,
  buildMobileWebMermaidFrameDocument
} from '../../src/shared/mobile-web/mermaid-frame-document'
import {
  MOBILE_WEB_MANIFEST_SCHEMA_VERSION,
  serializeMobileWebManifestForBuildId
} from '../../src/shared/mobile-web/manifest-contract'

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
  const script = Buffer.from('globalThis.__orcaPackagedMobileWeb=true', 'utf8')
  const scriptHash = sha256(script)
  const scriptPath = `assets/${scriptHash}.js`
  const csp = mobileWebDocumentCsp(MOBILE_RICH_MARKDOWN_EDITOR_SCRIPT_CSP_HASH)
  const document = Buffer.from(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="${csp}"><script src="./${scriptPath}"></script>`,
    'utf8'
  )
  const mermaidFrame = Buffer.from(
    buildMobileWebMermaidFrameDocument({
      theme: { background: 'black', primary: 'gray', text: 'white', line: 'silver' }
    }),
    'utf8'
  )
  const assets = [
    {
      path: scriptPath,
      sha256: scriptHash,
      byteLength: script.byteLength,
      contentType: 'text/javascript; charset=utf-8',
      role: 'script'
    },
    {
      path: 'index.html',
      sha256: sha256(document),
      byteLength: document.byteLength,
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
  await writeFile(join(root, scriptPath), script)
  await writeFile(join(root, 'index.html'), document)
  await writeFile(join(root, MOBILE_WEB_MERMAID_FRAME_PATH), mermaidFrame)
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}
