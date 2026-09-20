import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1')
}
const installed = resolve('node_modules/@xterm/xterm/lib/xterm.js')
const webglBundle = resolve(
  process.env.ORCA_AUDIT_WEBGL_BUNDLE ?? 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'
)
const current = [
  ['after', installed],
  ['after', installed.replace(/\.js$/, '.mjs')]
]
const bundles = process.env.ORCA_AUDIT_XTERM_BASELINE
  ? [['before', resolve(process.env.ORCA_AUDIT_XTERM_BASELINE)], ...current]
  : current
const browser = await chromium.launch({
  executablePath: process.env.ORCA_AUDIT_CHROMIUM,
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
})
const results = []
try {
  for (const [phase, bundle] of bundles) {
    const sha256 = createHash('sha256')
      .update(await readFile(bundle))
      .digest('hex')
    for (const mode of ['normal', 'dim']) {
      const page = await browser.newPage()
      try {
        await page.setContent('<div id="first"></div><div id="second"></div>')
        await page.addStyleTag({ path: resolve('node_modules/@xterm/xterm/css/xterm.css') })
        await page.addScriptTag({ path: webglBundle })
        if (bundle.endsWith('.mjs')) {
          const source = await readFile(bundle, 'utf8')
          await page.evaluate(
            async (url) => {
              window.Terminal = (await import(url)).Terminal
            },
            `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
          )
        } else {
          await page.addScriptTag({ path: bundle })
        }
        await page.evaluate(async (mode) => {
          const create = (id, text) => {
            const terminal = new Terminal({
              minimumContrastRatio: 3,
              cols: 4,
              rows: 1,
              scrollback: 0,
              allowProposedApi: true,
              logLevel: 'off'
            })
            terminal.open(document.getElementById(id))
            const addon = new WebglAddon.WebglAddon()
            terminal.loadAddon(addon)
            terminal._core.writeSync(text)
            addon._renderer.renderRows(0, 0)
            return { terminal, addon }
          }
          const first = create('first', `A \x1b[${mode === 'dim' ? 2 : 22}m\x1b[38;2;5;50;25mM`)
          const second = create('second', 'B')
          window.glyphAudit = { first, second, mode, index: 0 }
          await new Promise(requestAnimationFrame)
          await new Promise(requestIdleCallback)
        }, mode)
        const cdp = await page.context().newCDPSession(page)
        const samples = []
        for (const count of [0, 1000, 5000, 10000, 50000, 100000]) {
          const state = await page.evaluate((count) => {
            const { first, second, mode } = window.glyphAudit
            for (let index = window.glyphAudit.index; index < count; index++) {
              // Isolate contrast storage even when the older glyph cache has no entry cap.
              if (index > 0 && index % 1000 === 0) {
                first.addon.clearTextureAtlas()
              }
              const color = index + 1
              first.terminal._core.writeSync(
                `\x1b[1;2H\x1b[${mode === 'dim' ? 2 : 22}m\x1b[38;2;${color >> 16};${(color >> 8) & 255};${color & 255}m `
              )
              first.addon._renderer.renderRows(0, 0)
            }
            first.addon._renderer.renderRows(0, 0)
            second.addon._renderer.renderRows(0, 0)
            window.glyphAudit.index = count
            const atlas = first.addon._renderer._charAtlas
            const entries = (map) => {
              let result = 0
              for (const second of Object.values(map?._data._data ?? {})) {
                for (const inner of Object.values(second)) {
                  for (const fourth of Object.values(inner._data)) {
                    result += Object.keys(fourth).length
                  }
                }
              }
              return result
            }
            const countColors = (cache) =>
              Object.values(cache._color._data).reduce(
                (sum, row) => sum + Object.keys(row).length,
                0
              ) +
              Object.values(cache._css._data).reduce((sum, row) => sum + Object.keys(row).length, 0)
            const pixels = ({ terminal, addon }, cellIndex = 0) => {
              const gl = addon._renderer._gl
              const width = Math.floor(gl.drawingBufferWidth / terminal.cols)
              const height = gl.drawingBufferHeight
              const bytes = new Uint8Array(width * height * 4)
              gl.readPixels(cellIndex * width, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
              let hash = 2166136261
              for (const byte of bytes) {
                hash = Math.imul(hash ^ byte, 16777619)
              }
              return hash >>> 0
            }
            window.glyphAudit.pixelHash = pixels
            return {
              contrastProbePixels: pixels(first, 2),
              contrast: countColors(first.terminal._core._themeService.colors.contrastCache),
              dimContrast: countColors(first.terminal._core._themeService.colors.halfContrastCache),
              updates: count,
              firstCellPixels: pixels(first),
              secondCellPixels: pixels(second),
              regular: entries(atlas._cacheMap),
              combined: entries(atlas._cacheMapCombined),
              empty: entries(atlas._emptyCacheMap) + entries(atlas._emptyCacheMapCombined),
              pages: atlas.pages.length,
              glyphs: atlas.pages.reduce((n, page) => n + page.glyphs.length, 0),
              layoutVersion: atlas.pageLayoutVersion,
              shared: atlas === second.addon._renderer._charAtlas,
              preserved:
                first.terminal.buffer.active.getLine(0).getCell(0).getChars() === 'A' &&
                second.terminal.buffer.active.getLine(0).getCell(0).getChars() === 'B'
            }
          }, count)
          await cdp.send('HeapProfiler.collectGarbage')
          samples.push({ ...state, heap: (await cdp.send('Runtime.getHeapUsage')).usedSize })
        }
        assert.ok(samples.every((sample) => sample.shared && sample.preserved))
        assert.notEqual(samples[0].firstCellPixels, samples[0].secondCellPixels)
        assert.ok(
          samples.every(
            (sample) =>
              sample.firstCellPixels === samples[0].firstCellPixels &&
              sample.secondCellPixels === samples[0].secondCellPixels &&
              sample.contrastProbePixels === samples[0].contrastProbePixels
          )
        )
        if (phase === 'after') {
          assert.ok(
            samples.every((sample) => sample.contrast <= 4096 && sample.dimContrast <= 4096)
          )
        } else {
          assert.ok(samples.at(-1)[mode === 'dim' ? 'dimContrast' : 'contrast'] >= 100000)
        }
        const checks = await page.evaluate(() => {
          const { first, mode } = window.glyphAudit
          const cache =
            first.terminal._core._themeService.colors[
              mode === 'dim' ? 'halfContrastCache' : 'contrastCache'
            ]
          const entries = () =>
            Object.values(cache._color._data).reduce((sum, row) => sum + Object.keys(row).length, 0)
          const beforeAtlasClear = entries()
          first.addon.clearTextureAtlas()
          const afterAtlasClear = entries()
          cache.clear()
          const afterThemeClear = entries()
          first.addon.clearTextureAtlas()
          first.addon._renderer.renderRows(0, 0)
          const afterRecompute = entries()
          const recomputedProbePixels = window.glyphAudit.pixelHash(first, 2)
          return {
            beforeAtlasClear,
            afterAtlasClear,
            afterThemeClear,
            afterRecompute,
            recomputedProbePixels
          }
        })
        assert.equal(checks.beforeAtlasClear, checks.afterAtlasClear)
        assert.equal(checks.afterThemeClear, 0)
        assert.ok(checks.afterRecompute > 0)
        assert.equal(checks.recomputedProbePixels, samples[0].contrastProbePixels)
        results.push({
          phase,
          format: bundle.endsWith('.mjs') ? 'esm' : 'cjs',
          mode,
          sha256,
          samples,
          checks
        })
      } finally {
        await page.close()
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        browser: browser.version(),
        webglSha256: createHash('sha256')
          .update(await readFile(webglBundle))
          .digest('hex'),
        atlasClearEveryUpdates: 1000,
        results
      },
      null,
      2
    )
  )
} finally {
  await browser.close()
}
