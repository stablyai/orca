import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ORCAD_LOCAL_SERVE_SELECTION_ENTRY } from '../../src/shared/orcad-local-serve-selection'

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
  it('passes a package whose unpacked web client loads every file it names', () => {
    const resourcesDir = packagedResources({
      index: INDEX,
      assets: ['assets/web.js', 'assets/web.css']
    })
    expect(() => assertPackagedWebClient(resourcesDir)).not.toThrow()
  })

  it('fails a package with no unpacked web-index.html', () => {
    expect(() => assertPackagedWebClient(packagedResources({}))).toThrow(/missing unpacked/)
  })

  it('fails a package whose page loads a file that was not shipped', () => {
    const resourcesDir = packagedResources({ index: INDEX, assets: ['assets/web.js'] })
    expect(() => assertPackagedWebClient(resourcesDir)).toThrow(/assets\/web\.css/)
  })

  it('fails a page that loads nothing, which is not a real build', () => {
    expect(() => assertPackagedWebClient(packagedResources({ index: '<html></html>' }))).toThrow(
      /references no/
    )
  })

  it.each([
    null,
    {},
    ['assets/web.js'],
    ['web-index.html', 'index.html'],
    ['web-index.html', 'assets/../private'],
    ['web-index.html', 'assets//private'],
    ['web-index.html', 'assets/./private'],
    ['web-index.html', 'assets/a\\private'],
    ['web-index.html', 'assets/private.js.map'],
    ['web-index.html', '/assets/a'],
    ['web-index.html', 'assets/a\0.js'],
    ['web-index.html', 3]
  ])('rejects malformed shared web manifests: %j', (files) => {
    const resourcesDir = packagedResources({
      index: INDEX,
      assets: ['assets/web.js', 'assets/web.css']
    })
    writeFileSync(
      join(resourcesDir, 'app.asar.unpacked/out/renderer/.orca-web-client-files.json'),
      JSON.stringify(files)
    )
    expect(() => assertPackagedWebClient(resourcesDir)).toThrow(/invalid web file manifest/)
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

  it('fails when the CLI the web root resolves from is not unpacked', () => {
    const resourcesDir = packagedResources({
      index: INDEX,
      assets: ['assets/web.js', 'assets/web.css'],
      cli: false
    })
    expect(() => assertPackagedWebClient(resourcesDir)).toThrow(/no unpacked CLI/)
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

  it('looks where orca serve runs the entry from', () => {
    expect(SERVE_SELECTION_ENTRY).toBe(`main/${ORCAD_LOCAL_SERVE_SELECTION_ENTRY}.js`)
  })

  it('passes an unpacked entry whose relative requires are all unpacked', () => {
    const resourcesDir = packagedEntry({
      [SERVE_SELECTION_ENTRY]: 'require("../chunks/a.js"); require("node:fs")',
      'main/chunks/a.js': 'require("./b"); require("../persistence")',
      'main/chunks/b.js': '',
      'main/persistence/index.js': ''
    })
    expect(() => assertPackagedServeSelectionEntry(resourcesDir)).not.toThrow()
  })

  it('fails a package that left the entry inside app.asar (#27404)', () => {
    expect(() => assertPackagedServeSelectionEntry(packagedEntry({}))).toThrow(/missing unpacked/)
  })

  it('fails when a chunk the entry reaches was not unpacked', () => {
    const resourcesDir = packagedEntry({
      [SERVE_SELECTION_ENTRY]: 'require("../chunks/a.js")',
      'main/chunks/a.js': 'require("./b.js")'
    })
    expect(() => assertPackagedServeSelectionEntry(resourcesDir)).toThrow(/chunks.b\.js/)
  })
})
