import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ensureFixtureServer } from '../../component-fixtures/fixture-server-client.mjs'

const outIndex = process.argv.indexOf('--out')
const out = path.resolve(outIndex === -1 ? '.cache/bot-search-drag' : process.argv[outIndex + 1])
const { url } = await ensureFixtureServer()
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
page.setDefaultTimeout(60_000)
const results = []
const paint = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
async function cap() {
  return page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    return {
      saved: useAppStore.getState().sidebarBotsHeight,
      rendered: document.querySelector('[data-sidebar-bots-split]').offsetHeight
    }
  })
}
try {
  for (const theme of ['light', 'dark']) {
    for (const [name, delta, expected] of [
      ['no-move', 0, 80],
      ['masked-up-one', -1, 80],
      ['masked-partial-up', -60, 80],
      ['clamp-up', -200, 80],
      ['visible-down', 60, 240]
    ]) {
      await page.goto(
        `${url}/fixtures.html?id=bots/BotSidebarSearch:longListMinimumHeightResults&theme=${theme}`
      )
      await page.waitForFunction(() => document.documentElement.dataset.fixtureState === 'ready')
      const before = await cap()
      assert.deepEqual(before, { saved: 80, rendered: 180 })
      const handle = await page.locator('[data-sidebar-bots-resize-handle]').boundingBox()
      const x = handle.x + handle.width / 2
      const y = handle.y + handle.height / 2
      await page.mouse.move(x, y)
      await page.mouse.down()
      if (delta) {
        await page.mouse.move(x, y + delta)
        await paint()
      }
      await page.mouse.up()
      await paint()
      const after = await cap()
      assert.equal(after.saved, expected, `${name}: save only a visible change`)
      assert.equal(after.rendered, Math.max(180, expected))
      await page.locator('input[type=search]').press('Escape')
      await paint()
      const closed = await cap()
      assert.equal(closed.rendered, expected, `${name}: closing uses the retained/visible cap`)
      await page.locator('[data-bot-sidebar-search-toggle]').click()
      await paint()
      const reopened = await cap()
      assert.equal(reopened.rendered, Math.max(180, expected))
      await page
        .locator('#component-fixture-frame')
        .screenshot({ path: path.join(out, `${name}-${theme}.png`) })
      results.push({ name, theme, before, after, closed, reopened })
    }
  }
  await writeFile(
    path.join(out, 'geometry.json'),
    JSON.stringify({ browser: browser.version(), results }, null, 2)
  )
  console.log(
    `PASS: ${results.length} no-move, masked/clamped upward and visible downward drag/close/reopen cases`
  )
} catch (error) {
  await page.locator('#component-fixture-frame').screenshot({ path: path.join(out, 'failure.png') })
  await writeFile(
    path.join(out, 'failure.json'),
    JSON.stringify({ message: error.message, cap: await cap() }, null, 2)
  )
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
}
