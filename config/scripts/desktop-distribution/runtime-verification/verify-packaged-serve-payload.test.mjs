import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  SERVE_SELECTION_ENTRY,
  assertPackagedServeSelectionEntry,
  assertPackagedWebClient
} = require('./verify-packaged-serve-payload.cjs')

const roots = []

function packagedResources({ index, assets = [], cli = true }) {
  const resourcesDir = mkdtempSync(join(tmpdir(), 'verify-packaged-serve-payload-'))
  roots.push(resourcesDir)
  const outDir = join(resourcesDir, 'app.asar.unpacked', 'out')
  if (cli) {
    mkdirSync(join(outDir, 'cli'), { recursive: true })
  }
  const webDir = join(outDir, 'renderer')
  mkdirSync(join(webDir, 'assets'), { recursive: true })
  writeFileSync(
    join(webDir, '.orca-web-client-files.json'),
    JSON.stringify(['web-index.html', ...assets])
  )
  if (index !== undefined) {
    writeFileSync(join(webDir, 'web-index.html'), index)
  }
  for (const asset of assets) {
    writeFileSync(join(webDir, asset), '')
  }
  return resourcesDir
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const INDEX =
  '<script type="module" src="./assets/web.js"></script>' +
  '<link rel="stylesheet" href="./assets/web.css">'

describe('assertPackagedWebClient', () => {
  it('fails a package whose page loads a file that was not shipped', () => {
    const resourcesDir = packagedResources({ index: INDEX, assets: ['assets/web.js'] })
    expect(() => assertPackagedWebClient(resourcesDir)).toThrow(/assets\/web\.css/)
  })

  it('fails when a transitive worker is missing even though HTML assets exist', () => {
    const resourcesDir = packagedResources({
      index: INDEX,
      assets: ['assets/web.js', 'assets/web.css']
    })
    writeFileSync(
      join(resourcesDir, 'app.asar.unpacked/out/renderer/.orca-web-client-files.json'),
      JSON.stringify([
        'web-index.html',
        'assets/web.js',
        'assets/web.css',
        'assets/editor.worker.js'
      ])
    )
    expect(() => assertPackagedWebClient(resourcesDir)).toThrow(/editor.worker.js/)
  })
})

describe('assertPackagedServeSelectionEntry', () => {
  function packagedEntry(files) {
    const resourcesDir = mkdtempSync(join(tmpdir(), 'verify-packaged-serve-payload-'))
    roots.push(resourcesDir)
    const outDir = join(resourcesDir, 'app.asar.unpacked', 'out')
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(outDir, path)), { recursive: true })
      writeFileSync(join(outDir, path), content)
    }
    return resourcesDir
  }

  it('fails when a chunk the entry reaches was not unpacked', () => {
    const resourcesDir = packagedEntry({
      [SERVE_SELECTION_ENTRY]: 'require("../chunks/a.js")',
      'main/chunks/a.js': 'require("./b.js")'
    })
    expect(() => assertPackagedServeSelectionEntry(resourcesDir)).toThrow(/chunks.b\.js/)
  })
})
