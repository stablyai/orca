import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1')
}

const mobile = process.env.ORCA_AUDIT_MOBILE === '1'
const installed = resolve('node_modules/@xterm/xterm/lib/xterm.js')
const bundles = mobile
  ? [['after', resolve('mobile/src/terminal/terminal-webview-engine.generated.ts')]]
  : [
      ['after', installed],
      ['after', installed.replace(/\.js$/, '.mjs')]
    ]
const baseline = mobile
  ? process.env.ORCA_AUDIT_MOBILE_BASELINE
  : process.env.ORCA_AUDIT_XTERM_BASELINE
if (baseline) {
  bundles.unshift(['before', resolve(baseline)])
}
const browser = await chromium.launch({
  executablePath: process.env.ORCA_AUDIT_CHROMIUM,
  headless: true
})
const browserVersion = browser.version()
const results = []
const referenceColors = new Map()
let pagesOpened = 0
let pagesClosed = 0
try {
  for (const [phase, bundle] of bundles) {
    const source = mobile
      ? (await import(pathToFileURL(bundle).href)).XTERM_ENGINE_JS
      : await readFile(bundle, 'utf8')
    const sha256 = createHash('sha256').update(source).digest('hex')
    for (const theme of ['dark', 'light']) {
      for (const mode of ['normal', 'dim']) {
        const page = await browser.newPage()
        pagesOpened++
        try {
          await page.setContent('<div id="terminal"></div>')
          await page.addStyleTag({ path: resolve('node_modules/@xterm/xterm/css/xterm.css') })
          await (bundle.endsWith('.mjs')
            ? page.evaluate(
                async (url) => {
                  window.Terminal = (await import(url)).Terminal
                },
                `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
              )
            : page.addScriptTag({ content: source }))
          const initial = await page.evaluate(
            async ({ theme, mode }) => {
              const terminal = new Terminal({
                minimumContrastRatio: theme === 'dark' ? 3 : 4.5,
                theme:
                  theme === 'dark'
                    ? { background: '#000000', foreground: '#ffffff' }
                    : { background: '#ffffff', foreground: '#000000' },
                cols: 4,
                rows: 1,
                scrollback: 0,
                allowProposedApi: true,
                logLevel: 'off'
              })
              terminal.open(document.getElementById('terminal'))
              await new Promise(requestAnimationFrame)
              const renderer = terminal._core._renderService._renderer.value
              const colors = terminal._core._themeService.colors
              const probe = theme === 'dark' ? [5, 50, 25] : [245, 250, 240]
              const probeRgba = ((probe[0] << 24) | (probe[1] << 16) | (probe[2] << 8) | 255) >>> 0
              const draw = (rgb) => {
                terminal._core.writeSync(
                  `\x1b[?25l\x1b[H\x1b[${mode === 'dim' ? 2 : 22}m\x1b[38;2;${rgb.join(';')}mM`
                )
                renderer.renderRows(0, 0)
              }
              const count = (cache) =>
                Object.values(cache._color._data).reduce(
                  (sum, row) => sum + Object.keys(row).length,
                  0
                )
              const activeCache = () =>
                colors[mode === 'dim' ? 'halfContrastCache' : 'contrastCache']
              const state = () => ({
                contrast: count(colors.contrastCache),
                dimContrast: count(colors.halfContrastCache),
                probeCached: Object.values(activeCache()._color._data).some((row) =>
                  Object.hasOwn(row, probeRgba)
                )
              })
              const visible = () => {
                const row = terminal.element.querySelector('.xterm-rows > div')
                const cell = [...row.querySelectorAll('span')].find(
                  (span) => span.textContent === 'M'
                )
                if (!cell) {
                  throw new Error('Expected rendered probe glyph')
                }
                return {
                  color: getComputedStyle(cell).color,
                  opacity: getComputedStyle(cell).opacity,
                  html: row.innerHTML,
                  text: terminal.buffer.active.getLine(0).getCell(0).getChars()
                }
              }
              draw(probe)
              window.domContrastAudit = {
                terminal,
                renderer,
                colors,
                probe,
                draw,
                state,
                visible,
                index: 0
              }
              return {
                minimumContrastRatio: terminal.options.minimumContrastRatio,
                rawColor: `rgb(${probe.join(', ')})`,
                ...visible(),
                ...state()
              }
            },
            { theme, mode }
          )
          assert.equal(initial.text, 'M')
          assert.notEqual(
            initial.color,
            initial.rawColor,
            'Probe must exercise contrast correction'
          )
          assert.equal(initial.probeCached, true)
          const samples = []
          for (const count of [0, 1000, 4094, 4095, 4096, 5000, 10000]) {
            samples.push(
              await page.evaluate(
                ({ count, theme }) => {
                  const audit = window.domContrastAudit
                  for (let index = audit.index; index < count; index++) {
                    const color = theme === 'dark' ? index + 1 : 0xffffff - index
                    audit.draw([color >> 16, (color >> 8) & 255, color & 255])
                  }
                  audit.index = count
                  return { updates: count, ...audit.state() }
                },
                { count, theme }
              )
            )
          }
          if (phase === 'after') {
            assert.ok(
              samples.every((sample) => sample.contrast <= 4096 && sample.dimContrast <= 4096)
            )
            assert.equal(samples.at(-1).probeCached, false, 'Original color must be evicted')
          } else {
            assert.ok(samples.at(-1)[mode === 'dim' ? 'dimContrast' : 'contrast'] >= 10000)
            assert.equal(samples.at(-1).probeCached, true)
          }
          const checks = await page.evaluate(() => {
            const audit = window.domContrastAudit
            audit.draw(audit.probe)
            const revisited = { ...audit.visible(), ...audit.state() }
            audit.colors.contrastCache.clear()
            audit.colors.halfContrastCache.clear()
            const cleared = audit.state()
            audit.renderer.renderRows(0, 0)
            return { revisited, cleared, recomputed: { ...audit.visible(), ...audit.state() } }
          })
          for (const snapshot of [checks.revisited, checks.recomputed]) {
            assert.equal(snapshot.color, initial.color)
            assert.equal(snapshot.opacity, initial.opacity)
            assert.equal(snapshot.html, initial.html)
            assert.equal(snapshot.text, 'M')
            assert.equal(snapshot.probeCached, true)
          }
          assert.equal(checks.cleared.contrast, 0)
          assert.equal(checks.cleared.dimContrast, 0)
          assert.equal(checks.cleared.probeCached, false)
          const key = `${theme}/${mode}`
          const visibleColor = { color: initial.color, opacity: initial.opacity }
          if (referenceColors.has(key)) {
            assert.deepEqual(visibleColor, referenceColors.get(key))
          } else {
            referenceColors.set(key, visibleColor)
          }
          results.push({
            phase,
            format: mobile ? 'mobile-webview' : bundle.endsWith('.mjs') ? 'esm' : 'cjs',
            theme,
            mode,
            sha256,
            initial,
            samples,
            checks
          })
        } finally {
          await page
            .evaluate(() => window.domContrastAudit?.terminal.dispose())
            .catch(() => undefined)
          await page.close()
          assert.equal(page.isClosed(), true)
          pagesClosed++
        }
      }
    }
  }
} finally {
  await browser.close()
}
assert.equal(pagesClosed, pagesOpened)
assert.equal(browser.isConnected(), false)
console.log(
  JSON.stringify(
    {
      node: process.version,
      browser: browserVersion,
      headless: true,
      renderer: 'DOM',
      mobile,
      pagesOpened,
      pagesClosed,
      browserClosed: !browser.isConnected(),
      results
    },
    null,
    2
  )
)
