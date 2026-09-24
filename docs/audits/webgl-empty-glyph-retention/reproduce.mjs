import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1')
}
const installed = resolve('node_modules/@xterm/addon-webgl/lib/addon-webgl.js')
const current = [
  ['after', installed],
  ['after', installed.replace(/\.js$/, '.mjs')]
]
const bundles = process.env.ORCA_AUDIT_WEBGL_BASELINE
  ? [['before', resolve(process.env.ORCA_AUDIT_WEBGL_BASELINE)], ...current]
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
    for (const mode of ['space', 'space-joiner']) {
      const page = await browser.newPage()
      try {
        await page.setContent('<div id="first"></div><div id="second"></div>')
        await page.addStyleTag({ path: resolve('node_modules/@xterm/xterm/css/xterm.css') })
        await page.addScriptTag({ path: resolve('node_modules/@xterm/xterm/lib/xterm.js') })
        if (bundle.endsWith('.mjs')) {
          const source = await readFile(bundle, 'utf8')
          await page.evaluate(
            async (url) => {
              window.WebglAddon = await import(url)
            },
            `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
          )
        } else {
          await page.addScriptTag({ path: bundle })
        }
        await page.evaluate(async (mode) => {
          const create = (id, text) => {
            const terminal = new Terminal({
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
          const first = create('first', 'A')
          const second = create('second', 'B')
          window.glyphAudit = { first, second, mode, index: 0 }
          await new Promise(requestAnimationFrame)
          await new Promise(requestIdleCallback)
        }, mode)
        // The atlas warms ASCII in idle tasks; sample only after the final queued glyph exists.
        await page.waitForFunction(() =>
          Boolean(window.glyphAudit.first.addon._renderer._charAtlas._cacheMap.get(125, 0, 0, 0))
        )
        await page.evaluate(() => {
          const atlas = window.glyphAudit.first.addon._renderer._charAtlas
          const draw = atlas._drawToCache
          window.glyphAudit.visibleRasterizations = 0
          atlas._drawToCache = function (...args) {
            if (args[0] !== 32 && args[0] !== ' \u200d') {
              window.glyphAudit.visibleRasterizations++
            }
            return draw.apply(this, args)
          }
        })
        const cdp = await page.context().newCDPSession(page)
        const samples = []
        for (const count of [0, 1000, 5000, 10000, 50000, 100000]) {
          const state = await page.evaluate((count) => {
            const { first, second, mode } = window.glyphAudit
            for (let index = window.glyphAudit.index; index < count; index++) {
              const color = index + 1
              first.terminal._core.writeSync(
                `\x1b[1;2H\x1b[38;2;${color >> 16};${(color >> 8) & 255};${color & 255}m ${mode === 'space-joiner' ? '\u200d' : ''}`
              )
              first.addon._renderer.renderRows(0, 0)
            }
            first.addon._renderer.renderRows(0, 0)
            second.addon._renderer.renderRows(0, 0)
            window.glyphAudit.index = count
            const atlas = first.addon._renderer._charAtlas
            // This audit is tied to the pinned addon's private FourKeyMap storage.
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
            const pixels = ({ terminal, addon }) => {
              const gl = addon._renderer._gl
              const width = Math.floor(gl.drawingBufferWidth / terminal.cols)
              const height = gl.drawingBufferHeight
              const bytes = new Uint8Array(width * height * 4)
              gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
              let hash = 2166136261
              for (const byte of bytes) {
                hash = Math.imul(hash ^ byte, 16777619)
              }
              return hash >>> 0
            }
            return {
              updates: count,
              visibleRasterizations: window.glyphAudit.visibleRasterizations,
              firstCellPixels: pixels(first),
              secondCellPixels: pixels(second),
              regular: entries(atlas._cacheMap),
              combined: entries(atlas._cacheMapCombined),
              empty: atlas._emptyGlyphKeys.size,
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
        const checks = await page.evaluate(() => {
          const { first, mode } = window.glyphAudit
          const atlas = first.addon._renderer._charAtlas
          let rasterizations = 0
          const draw = atlas._drawToCache
          atlas._drawToCache = function (...args) {
            rasterizations++
            return draw.apply(this, args)
          }
          const paint = (color) => {
            first.terminal._core.writeSync(
              `\x1b[1;2H\x1b[38;2;${color >> 16};${(color >> 8) & 255};${color & 255}m ${mode === 'space-joiner' ? '\u200d' : ''}`
            )
            first.addon._renderer.renderRows(0, 0)
          }
          for (let color = 99937; color <= 100000; color++) {
            paint(color)
          }
          atlas._drawToCache = draw

          // Eviction drops the oldest admission only, so a full cap's worth of fresh variants
          // stays resident and redrawing all of them is free. Clear-all eviction wipes the cap
          // mid-fill, and re-probing would rasterize most of the window again.
          const cap = 4096
          // Overfill and probe inside a margin, so a stray admission shifting the window cannot
          // turn a single miss into a cascade of them and make the result unreadable.
          const margin = 128
          for (let index = 0; index < cap + margin; index++) {
            paint(200000 + index)
          }
          let residentRasterizations = 0
          atlas._drawToCache = function (...args) {
            residentRasterizations++
            return draw.apply(this, args)
          }
          for (let index = margin; index < cap + margin; index++) {
            paint(200000 + index)
          }
          // Only the oldest admission of the fill was evicted, so redrawing it costs one draw.
          const beforeEvicted = residentRasterizations
          paint(200000)
          const evictedRasterizations = residentRasterizations - beforeEvicted
          atlas._drawToCache = draw

          first.addon.clearTextureAtlas()
          // Exercise explicit clear with only invisible glyph metadata and no drawn atlas cells.
          atlas.getRasterizedGlyph(32, 0, 0x3000001, 0, false, first.terminal.element)
          first.addon.clearTextureAtlas()
          return {
            rasterizations,
            residentRasterizations,
            evictedRasterizations,
            emptyAfterClear: atlas._emptyGlyphKeys?.size ?? null
          }
        })
        assert.ok(
          samples.every((sample) => sample.shared && sample.preserved && sample.pages === 1)
        )
        assert.equal(checks.rasterizations, 0)
        // Clear-all eviction wipes the window mid-fill and scores in the thousands here. The
        // slack covers the default-colour space aging out of the window and being re-admitted.
        assert.ok(checks.residentRasterizations <= 2, `resident ${checks.residentRasterizations}`)
        assert.equal(checks.evictedRasterizations, 1)
        assert.notEqual(samples[0].firstCellPixels, samples[0].secondCellPixels)
        assert.ok(
          samples.every(
            (sample) =>
              sample.firstCellPixels === samples[0].firstCellPixels &&
              sample.secondCellPixels === samples[0].secondCellPixels
          )
        )
        if (phase === 'after') {
          assert.ok(
            samples.every(
              (sample) =>
                sample.empty <= 4096 &&
                sample.regular === samples[0].regular &&
                sample.combined === samples[0].combined &&
                sample.glyphs === samples[0].glyphs &&
                sample.visibleRasterizations === 0
            )
          )
          assert.equal(checks.emptyAfterClear, 0)
          assert.equal(samples[0].layoutVersion, samples.at(-1).layoutVersion)
        } else {
          assert.ok(samples.at(-1).regular + samples.at(-1).combined >= 100000)
        }
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
    JSON.stringify({ node: process.version, browser: browser.version(), results }, null, 2)
  )
} finally {
  await browser.close()
}
