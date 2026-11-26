import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { PNG } from 'pngjs'
import { ensureFixtureServer } from '../../component-fixtures/fixture-server-client.mjs'

const outIndex = process.argv.indexOf('--out')
const out = path.resolve(
  outIndex === -1 ? '.cache/bot-search-separator' : process.argv[outIndex + 1]
)
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

async function sample(name, scrolled) {
  await paint()
  const box = await page
    .locator('input[type=search]')
    .evaluate((element) => element.parentElement.getBoundingClientRect().toJSON())
  const png = PNG.sync.read(await page.screenshot())
  const pixel = (x, y) => [
    ...png.data.subarray(
      (Math.floor(y * 2) * png.width + Math.floor(x * 2)) * 4,
      (Math.floor(y * 2) * png.width + Math.floor(x * 2)) * 4 + 4
    )
  ]
  const above = pixel(box.left + 1, box.bottom - 1.5)
  const line = pixel(box.left + 1, box.bottom - 0.5)
  for (let x = box.left + 0.5; x < box.right; x += 0.5) {
    assert.deepEqual(
      pixel(x, box.bottom - 0.5),
      scrolled ? line : above,
      'field edge paints uniformly without a notch'
    )
    if (!scrolled) {
      assert.deepEqual(
        pixel(x, box.bottom + 0.5),
        above,
        'no stray line in the list gutter at scrollTop=0'
      )
    }
  }
  if (scrolled) {
    assert.notDeepEqual(line, above, 'separator paints over the full field edge while scrolled')
  } else {
    assert.deepEqual(line, above, 'field has no separator at the top')
  }
  await page.locator('#component-fixture-frame').screenshot({ path: path.join(out, `${name}.png`) })
  return { name, box, above, line, scrolled }
}

try {
  for (const theme of ['light', 'dark']) {
    for (const name of ['longListResults', 'longListNoMatches', 'longListSmallestWindow']) {
      await page.goto(`${url}/fixtures.html?id=bots/BotSidebarSearch:${name}&theme=${theme}`)
      await page.waitForFunction(() => document.documentElement.dataset.fixtureState === 'ready')
      results.push(await sample(`${name}-top-${theme}`, false))
      if (name !== 'longListNoMatches') {
        const scroller = page.locator('[data-bot-sidebar-search] .bot-sidebar-scrollbar')
        await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
        results.push(await sample(`${name}-scrolled-${theme}`, true))
        await scroller.evaluate((element) => element.scrollTo({ top: 0 }))
        results.push(await sample(`${name}-returned-${theme}`, false))
      }
    }
  }
  await writeFile(
    path.join(out, 'pixels.json'),
    JSON.stringify({ browser: browser.version(), results }, null, 2)
  )
  console.log(
    `PASS: ${results.length} light/dark separator paint checks at top, scrolled and returned to top`
  )
} catch (error) {
  await page.locator('#component-fixture-frame').screenshot({ path: path.join(out, 'failure.png') })
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
}
