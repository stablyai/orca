import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PNG } from 'pngjs'
import { chromium } from 'playwright-core'
import { ensureFixtureServer } from '../../component-fixtures/fixture-server-client.mjs'

const outIndex = process.argv.indexOf('--out')
const out = path.resolve(
  outIndex === -1 ? '.cache/bot-search-empty-list' : process.argv[outIndex + 1]
)
await mkdir(out, { recursive: true })
const { url } = await ensureFixtureServer()
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
page.setDefaultTimeout(60_000)
const results = []
const paint = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
async function hide(value) {
  await page.evaluate(async (hidePausedBots) => {
    const { useAppStore } = await import('/src/store/index.ts')
    useAppStore.setState({
      botSidebarView: { ...useAppStore.getState().botSidebarView, hidePausedBots }
    })
  }, value)
  await paint()
}
async function sample(name, scrolled) {
  await paint()
  const box = await page
    .locator('input[type=search]')
    .evaluate((element) => element.parentElement.getBoundingClientRect().toJSON())
  const png = PNG.sync.read(await page.screenshot())
  const pixel = (y) => [
    ...png.data.subarray(
      (Math.floor(y * 2) * png.width + Math.floor((box.left + 1) * 2)) * 4,
      (Math.floor(y * 2) * png.width + Math.floor((box.left + 1) * 2)) * 4 + 4
    )
  ]
  const above = pixel(box.bottom - 1.5)
  const edge = pixel(box.bottom - 0.5)
  if (scrolled) {
    assert.notDeepEqual(edge, above)
  } else {
    assert.deepEqual(edge, above)
  }
  await page.locator('#component-fixture-frame').screenshot({ path: path.join(out, `${name}.png`) })
  results.push({ name, scrolled, above, edge })
}
try {
  for (const theme of ['light', 'dark']) {
    await page.goto(
      `${url}/fixtures.html?id=bots/BotSidebarSearch:longListOpenEmpty&theme=${theme}`
    )
    await page.waitForFunction(() => document.documentElement.dataset.fixtureState === 'ready')
    await page.evaluate(async () => {
      const { readHostBots } = await import('/src/lib/bot-catalog-snapshot.ts')
      const { stubBots } = await import('/src/component-fixtures/fixture-bots.ts')
      stubBots(readHostBots('local').map((bot) => ({ ...bot, paused: true })))
    })
    const list = page.locator('[data-bot-sidebar-list]')
    const identity = await list.elementHandle()
    const field = page.locator('input[type=search]')
    const fieldIdentity = await field.elementHandle()
    await list.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
    await sample(`initial-scrolled-${theme}`, true)
    for (let cycle = 0; cycle < 2; cycle++) {
      await hide(true)
      assert.ok(
        await list.evaluate((element, previous) => element === previous, identity),
        'empty state keeps the same scroller'
      )
      assert.equal(await list.evaluate((element) => element.scrollTop), 0)
      await sample(`hidden-${cycle}-${theme}`, false)
      await hide(false)
      assert.ok(await list.evaluate((element, previous) => element === previous, identity))
      assert.ok(await field.evaluate((element, previous) => element === previous, fieldIdentity))
      assert.equal(await field.inputValue(), '')
      await sample(`returned-top-${cycle}-${theme}`, false)
      await list.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
      await sample(`returned-scrolled-${cycle}-${theme}`, true)
    }
    await field.fill('bot')
    await hide(true)
    assert.equal(await field.inputValue(), 'bot', 'filtering preserves the live query')
    await field.fill('')
    await sample(`cleared-hidden-${theme}`, false)
    const oldFieldRow = await field.evaluateHandle((element) => element.parentElement)
    await field.press('Escape')
    await hide(false)
    await list.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
    await paint()
    assert.equal(
      await oldFieldRow.evaluate((element) => element.hasAttribute('data-bot-search-scrolled')),
      false,
      'closed search listener is detached'
    )
    await identity.dispose()
    await fieldIdentity.dispose()
    await oldFieldRow.dispose()
  }
  await writeFile(path.join(out, 'pixels.json'), JSON.stringify({ results }, null, 2))
  console.log(
    `PASS: ${results.length} empty/list cycles and separator paint checks; query, DOM identity and cleanup preserved`
  )
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png') })
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
}
