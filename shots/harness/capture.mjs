// Ad hoc: renders seeded component fixtures with the browser window set to the fixture width, so the
// fixed floating panel button lands where it would in a window that narrow; measures Send against it.
// Usage: node capture.mjs <repo> <outDir>
import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const [repo, outDir] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const { ensureFixtureServer } = await import(
  pathToFileURL(path.join(repo, 'config/scripts/component-fixtures/fixture-server-client.mjs')).href
)
const { chromium } = await import(
  pathToFileURL(path.join(repo, 'node_modules/playwright-core/index.mjs')).href
)
const { url } = await ensureFixtureServer()
const base = 'native-chat/tools/tasks/dock/NativeChatWorkerDock'
const cases = [
  ['composerDefault390', 390],
  ['composerOverSend390', 390],
  ['composerDefault320', 320],
  ['composerOverSend320', 320],
  ['longListNarrowMidScroll', 390],
  ['longListMidScroll', 720]
]
const browser = await chromium.launch({ headless: true })
const report = []
try {
  for (const [name, width] of cases) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: 844 },
        deviceScaleFactor: 2
      })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${url}/fixtures.html?worker=1`, { timeout: 180_000, waitUntil: 'domcontentloaded' })
      await page.waitForFunction(() => Boolean(window.__orcaComponentFixtureHost), undefined, { timeout: 180_000 })
      await page.evaluate(
        ([id, t]) => window.__orcaComponentFixtureHost.render(id, t),
        [`${base}:${name}`, theme]
      )
      await page.waitForFunction(() =>
        ['ready', 'error'].includes(document.documentElement.dataset.fixtureState ?? '')
      )
      await page.waitForTimeout(600)
      const facts = await page.evaluate(() => {
        const rect = (el) => {
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
        }
        const send = [...document.querySelectorAll('button')].find((b) =>
          /^Send/.test(b.getAttribute('aria-label') ?? b.textContent ?? '')
        )
        const toggle = document.querySelector('[data-floating-terminal-toggle]')
        const s = rect(send)
        const f = rect(toggle)
        const overlap =
          s && f
            ? s.left < f.right && f.left < s.right && s.top < f.bottom && f.top < s.bottom
            : null
        const saved = localStorage.getItem('orca-floating-terminal-trigger-position-v2')
        let savedRect = null
        if (saved) {
          const p = JSON.parse(saved)
          const left = innerWidth - 36 - p.offsetX
          const top = innerHeight - 36 - p.offsetY
          savedRect = { left, top, right: left + 36, bottom: top + 36 }
        }
        const savedOverSend =
          savedRect && s
            ? s.left < savedRect.right &&
              savedRect.left < s.right &&
              s.top < savedRect.bottom &&
              savedRect.top < s.bottom
            : null
        const dockFrame = document.querySelector('[data-native-chat-worker-dock]')
        const roster = document.querySelector('[data-native-chat-background-tasks] [role="region"]')
        const header = document.querySelector('[data-worker-dock-header]')
        const scrollers = [...document.querySelectorAll('[data-native-chat-worker-dock] *')]
          .concat(dockFrame ? [dockFrame] : [])
          .filter((el) => {
            const style = getComputedStyle(el)
            return (
              /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1
            )
          }).length
        let sliced = null
        if (roster) {
          const top = roster.getBoundingClientRect().top
          const bottom = roster.getBoundingClientRect().bottom
          sliced = [...roster.querySelectorAll('[data-index]')].some((row) => {
            const r = row.getBoundingClientRect()
            return (r.top < top - 1 && r.bottom > top + 1) || (r.top < bottom - 1 && r.bottom > bottom + 1)
          })
        }
        return {
          innerWidth,
          send: s,
          toggle: f,
          sendCovered: overlap,
          savedSpot: savedRect,
          savedSpotWouldCoverSend: savedOverSend,
          rosterScrollTop: roster?.scrollTop ?? null,
          headerTop: rect(header)?.top ?? null,
          dockTop: rect(dockFrame)?.top ?? null,
          scrollingElementsInDock: scrollers,
          rowSlicedAtRosterEdge: sliced
        }
      })
      const file = path.join(outDir, `${name}.${theme}.png`)
      await page.screenshot({ path: file, fullPage: false })
      report.push({ fixture: name, theme, viewport: width, ...facts, errors })
      await context.close()
    }
  }
} finally {
  await browser.close()
  writeFileSync(path.join(outDir, 'window-width-report.json'), JSON.stringify(report, null, 2))
}
console.log(JSON.stringify(report.map((r) => ({ f: r.fixture, t: r.theme, covered: r.sendCovered, savedWould: r.savedSpotWouldCoverSend, scrollers: r.scrollingElementsInDock, sliced: r.rowSlicedAtRosterEdge, st: r.rosterScrollTop, errors: r.errors.length })), null, 1))
