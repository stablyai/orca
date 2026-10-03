import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from '../../src/shared/child-process/run-process'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = resolve('config/scripts/project-renderer-web-client.mjs')
const temporaryRoots = []

function projectFixture(root) {
  return runProcess({
    program: process.execPath,
    args: [scriptPath],
    cwd: root,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
    timeoutMs: 30000
  })
}

function writeFixtureFile(root, relativePath, contents) {
  const targetPath = join(root, relativePath)
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, contents)
}

function createRendererFixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-web-projection-'))
  temporaryRoots.push(root)
  const manifest = {
    'web-index.html': {
      file: 'assets/web-entry.js',
      isEntry: true,
      imports: ['_web-shared.js'],
      dynamicImports: ['src/lazy.ts'],
      assets: [
        'assets/web-icon-192-Fi1x2.png',
        'assets/web-icon-512-Zz9y8.png',
        'assets/web-app-manifest-Qq4w5.webmanifest'
      ]
    },
    '_web-shared.js': {
      file: 'assets/web-shared.js',
      css: ['assets/web.css'],
      assets: ['assets/logo.png']
    },
    'src/lazy.ts': { file: 'assets/lazy.js' },
    'index.html': { file: 'assets/desktop-entry.js', isEntry: true }
  }

  writeFixtureFile(root, 'out/renderer/.vite/manifest.json', JSON.stringify(manifest))
  writeFixtureFile(
    root,
    'out/renderer/web-index.html',
    '<script type="module" src="./assets/web-entry.js"></script>\n' +
      '<link rel="manifest" href="./assets/web-app-manifest-Qq4w5.webmanifest" />'
  )
  writeFixtureFile(
    root,
    'out/renderer/assets/web-app-manifest-Qq4w5.webmanifest',
    JSON.stringify({ name: 'Orca', icons: [{ src: './web-icon-192-Fi1x2.png', sizes: '192x192' }] })
  )
  writeFixtureFile(root, 'out/renderer/assets/web-icon-192-Fi1x2.png', 'fixture-icon-192')
  writeFixtureFile(root, 'out/renderer/assets/web-icon-512-Zz9y8.png', 'fixture-icon-512')
  writeFixtureFile(
    root,
    'out/renderer/assets/web-entry.js',
    'import "./web-shared.js"; new Worker(new URL("editor.worker-fixture.js", import.meta.url));'
  )
  writeFixtureFile(root, 'out/renderer/assets/web-shared.js', 'export const value = 1;')
  writeFixtureFile(root, 'out/renderer/assets/lazy.js', 'export const lazyValue = true;')
  writeFixtureFile(root, 'out/renderer/assets/web.css', '.root { color: red; }')
  writeFixtureFile(root, 'out/renderer/assets/logo.png', 'fixture-logo')
  writeFixtureFile(
    root,
    'out/renderer/assets/editor.worker-fixture.js',
    'self.onmessage = function (event) { self.postMessage(event.data) }'
  )
  writeFixtureFile(root, 'out/renderer/assets/desktop-entry.js', 'export const desktop = true;')
  writeFixtureFile(root, 'out/web/stale.js', 'stale')
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true })
  }
})

describe('renderer web client projection', () => {
  it('keeps the build-only manifest out of packaged apps', () => {
    const builderConfig = readFileSync(resolve('config/electron-builder.config.cjs'), 'utf8')

    expect(builderConfig).toContain("'!out/renderer/.vite{,/**/*}'")
  })

  it('copies and minifies only the web dependency closure', async () => {
    const root = createRendererFixture()
    const result = await projectFixture(root)

    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('Projected web client: 10 files')
    expect(existsSync(join(root, 'out/web/web-index.html'))).toBe(true)
    expect(existsSync(join(root, 'out/web/assets/editor.worker-fixture.js'))).toBe(true)
    expect(existsSync(join(root, 'out/web/assets/logo.png'))).toBe(true)
    expect(existsSync(join(root, 'out/web/assets/desktop-entry.js'))).toBe(false)
    expect(existsSync(join(root, 'out/web/stale.js'))).toBe(false)
    expect(readFileSync(join(root, 'out/web/assets/web.css'), 'utf8')).toBe('.root{color:red}\n')
  })

  it('carries the web app manifest and its icons into the web client', async () => {
    const root = createRendererFixture()
    const result = await projectFixture(root)

    expect(result.code, result.stderr).toBe(0)
    for (const file of [
      'assets/web-app-manifest-Qq4w5.webmanifest',
      'assets/web-icon-192-Fi1x2.png',
      'assets/web-icon-512-Zz9y8.png'
    ]) {
      expect(existsSync(join(root, 'out/web', file)), file).toBe(true)
    }
    expect(readFileSync(join(root, 'out/web/web-index.html'), 'utf8')).toContain(
      'href="./assets/web-app-manifest-Qq4w5.webmanifest"'
    )
    const servedManifest = readFileSync(
      join(root, 'out/web/assets/web-app-manifest-Qq4w5.webmanifest'),
      'utf8'
    )
    expect(JSON.parse(servedManifest)).toEqual({
      name: 'Orca',
      icons: [{ src: './web-icon-192-Fi1x2.png', sizes: '192x192' }]
    })
  })

  it('follows transitive relative references and cycles with the existing substring behavior', async () => {
    const root = createRendererFixture()
    writeFixtureFile(
      root,
      'out/renderer/assets/editor.worker-fixture.js',
      'const referenced = "../workers/one.mjs"; const overlapping = "assets/token.png.backup";'
    )
    writeFixtureFile(root, 'out/renderer/workers/one.mjs', 'const icon = "../icons/link.svg";')
    writeFixtureFile(root, 'out/renderer/icons/link.svg', '<image href="../workers/one.mjs"/>')
    writeFixtureFile(root, 'out/renderer/assets/token.png', 'substring-token')
    writeFixtureFile(root, 'out/renderer/assets/token.png.backup', 'longer-token')
    writeFixtureFile(root, 'out/renderer/workers/unreferenced.mjs', 'export const absent = true;')

    const result = await projectFixture(root)

    expect(result.code, result.stderr).toBe(0)
    for (const file of [
      'workers/one.mjs',
      'icons/link.svg',
      'assets/token.png',
      'assets/token.png.backup'
    ]) {
      expect(existsSync(join(root, 'out/web', file)), file).toBe(true)
    }
    expect(readFileSync(join(root, 'out/web/assets/token.png'), 'utf8')).toBe('substring-token')
    expect(existsSync(join(root, 'out/web/workers/unreferenced.mjs'))).toBe(false)
  })

  it('retains all PDFJS viewer asset directories even without textual references', async () => {
    const root = createRendererFixture()
    const assets = ['cmaps/fixture.bcmap', 'standard_fonts/fixture.pfb', 'wasm/fixture.wasm']
    for (const file of assets) {
      writeFixtureFile(root, `out/renderer/${file}`, Buffer.from([0, 255, 42]))
    }

    const result = await projectFixture(root)

    expect(result.code, result.stderr).toBe(0)
    for (const file of assets) {
      expect(readFileSync(join(root, 'out/web', file))).toEqual(Buffer.from([0, 255, 42]))
    }
  })

  it('follows referenced PDFJS text assets without expanding unreferenced viewer modules', async () => {
    const root = createRendererFixture()
    writeFixtureFile(
      root,
      'out/renderer/assets/web-entry.js',
      'const viewer = "../wasm/viewer.mjs";'
    )
    writeFixtureFile(
      root,
      'out/renderer/wasm/viewer.mjs',
      'const image = "../assets/viewer-image.png";'
    )
    writeFixtureFile(
      root,
      'out/renderer/wasm/unused.mjs',
      'const unused = "../assets/unreferenced-image.png";'
    )
    writeFixtureFile(root, 'out/renderer/assets/viewer-image.png', 'viewer-image')
    writeFixtureFile(root, 'out/renderer/assets/unreferenced-image.png', 'unreferenced-image')

    const result = await projectFixture(root)

    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(join(root, 'out/web/wasm/viewer.mjs'))).toBe(true)
    expect(existsSync(join(root, 'out/web/wasm/unused.mjs'))).toBe(true)
    expect(readFileSync(join(root, 'out/web/assets/viewer-image.png'), 'utf8')).toBe('viewer-image')
    expect(existsSync(join(root, 'out/web/assets/unreferenced-image.png'))).toBe(false)
  })

  it.each(['../outside.js', '/absolute.js', 'C:/drive.js', 'assets\\backslash.js'])(
    'rejects invalid manifest output paths: %s',
    async (outputPath) => {
      const root = createRendererFixture()
      const manifestPath = join(root, 'out/renderer/.vite/manifest.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest['web-index.html'].file = outputPath
      writeFileSync(manifestPath, JSON.stringify(manifest))

      const result = await projectFixture(root)

      expect(result.code).toBe(1)
      expect(result.stderr).toContain('Invalid renderer output path:')
      expect(readFileSync(join(root, 'out/web/stale.js'), 'utf8')).toBe('stale')
    }
  )

  it('fails when the renderer manifest omits the web entry', async () => {
    const root = createRendererFixture()
    writeFixtureFile(root, 'out/renderer/.vite/manifest.json', '{}')
    const result = await projectFixture(root)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Renderer manifest is missing entry: web-index.html')
  })

  it('rejects renderer entries that execute another entry root', async () => {
    const root = createRendererFixture()
    const manifestPath = join(root, 'out/renderer/.vite/manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest['web-index.html'].dynamicImports.push('index.html')
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const result = await projectFixture(root)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Renderer entry web-index.html executes entry index.html')
  })
})
