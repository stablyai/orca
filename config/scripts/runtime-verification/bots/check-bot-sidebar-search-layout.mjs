import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ensureFixtureServer } from '../../component-fixtures/fixture-server-client.mjs'

import { geometry, checkRows, checkShell } from './bot-sidebar-search-layout-observations.mjs'

const outIndex = process.argv.indexOf('--out')
const out = path.resolve(outIndex === -1 ? '.cache/bot-search-layout' : process.argv[outIndex + 1])
const removeRowShrink = process.argv.includes('--remove-row-shrink')
const { url } = await ensureFixtureServer()
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
const results = []

async function render(name, theme) {
  await page.goto(`${url}/fixtures.html?id=bots/BotSidebarSearch:${name}&theme=${theme}`)
  await page.waitForFunction(() =>
    ['ready', 'error'].includes(document.documentElement.dataset.fixtureState)
  )
  assert.equal(await page.getAttribute('html', 'data-fixture-state'), 'ready')
  await page.locator('input[type=search]').focus()
}

try {
  for (const theme of ['light', 'dark']) {
    for (const [name, folded] of [
      ['longListResults', false],
      ['longListMinimumHeightResults', false],
      ['longListProjectsFolded', true],
      ['longListSmallestWindow', false]
    ]) {
      await render(name, theme)
      if (removeRowShrink) {
        await page
          .locator('[data-bot-search-result]')
          .evaluateAll((rows) => rows.forEach((row) => row.classList.remove('shrink-0')))
      }
      const before = await geometry(page)
      checkRows(before)
      checkShell(before, folded)
      assert.ok(
        before.rows[0].box.top >= before.scroller.top,
        'first row starts fully at the viewport top'
      )
      assert.ok(before.rows[1].box.bottom <= before.scroller.bottom, 'two complete results fit')
      assert.ok(
        before.scrollHeight > before.clientHeight,
        'results overflow and need their own scroller'
      )
      await page
        .locator('#component-fixture-frame')
        .screenshot({ path: path.join(out, `${name}.${theme}.png`) })
      const scroll = page.locator('[data-bot-sidebar-search] .bot-sidebar-scrollbar')
      await scroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
      const after = await geometry(page)
      assert.ok(after.scroll > 0, 'result scroller owns scrolling')
      assert.deepEqual(after.field, before.field, 'field fixed during result scroll')
      assert.deepEqual(after.projects, before.projects, 'Projects geometry unchanged during scroll')
      assert.equal(after.projectsScroll, before.projectsScroll)
      assert.equal(
        after.outerScroll,
        before.outerScroll,
        'outer viewport does not scroll with results'
      )
      assert.deepEqual(after.shell, before.shell)
      const last = after.rows.at(-1).box
      assert.ok(
        last.top >= after.scroller.top && last.bottom <= after.scroller.bottom,
        'last result readable in full'
      )
      await scroll.hover()
      await page.mouse.wheel(0, 500)
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
      await page.waitForFunction(
        ({ top }) => document.querySelector('[data-sidebar-content-viewport]').scrollTop === top,
        { top: before.outerScroll }
      )
      assert.equal(
        (await geometry(page)).outerScroll,
        before.outerScroll,
        'wheel at end does not chain into sidebar chrome'
      )
      await page
        .locator('#component-fixture-frame')
        .screenshot({ path: path.join(out, `${name}-scrolled.${theme}.png`) })
      await page.getByRole('button', { name: 'Clear search', exact: true }).click()
      const field = page.locator('input[type=search]')
      assert.equal(await field.inputValue(), '')
      assert.ok(await field.evaluate((element) => element === document.activeElement))
      assert.equal(await page.locator('[data-bot-search-result]').count(), 0)
      const list = page.locator('[data-bot-sidebar-list]')
      await list.waitFor({ state: 'visible' })
      assert.ok(await list.isVisible(), 'clearing returns the ordinary list')
      await list.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
      const listScroll = await list.evaluate((element) => element.scrollTop)
      assert.ok(listScroll > 0)
      await field.fill('bot')
      await page.locator('[data-bot-search-result]').first().waitFor()
      await page.getByRole('button', { name: 'Clear search', exact: true }).click()
      await list.waitFor({ state: 'visible' })
      assert.equal(
        await list.evaluate((element) => element.scrollTop),
        listScroll,
        'query-clear preserves the ordinary list position'
      )
      const plain = await field.evaluate((element) => ({
        field: element.getBoundingClientRect().toJSON(),
        list: document.querySelector('[data-bot-sidebar-list]').getBoundingClientRect().toJSON()
      }))
      assert.ok(plain.field.bottom + 3 <= plain.list.top, 'empty field ring clears ordinary list')
      await page
        .locator('#component-fixture-frame')
        .screenshot({ path: path.join(out, `${name}-cleared.${theme}.png`) })
      await field.press('Escape')
      assert.equal(await page.locator('input[type=search]').count(), 0)
      if (name === 'longListMinimumHeightResults') {
        assert.equal(
          await page
            .locator('[data-sidebar-bots-split]')
            .evaluate((element) => element.offsetHeight),
          80,
          'closing restores saved cap'
        )
      }
      results.push({ name, theme, before, after, queryClear: 'passed' })
    }
  }
  await writeFile(
    path.join(out, 'geometry.json'),
    JSON.stringify({ browser: browser.version(), results }, null, 2)
  )
  console.log(
    `PASS: ${results.length} component/theme cases, row content, scroll ownership, last row, query-clear, shell and ring geometry`
  )
} catch (error) {
  await page.locator('#component-fixture-frame').screenshot({ path: path.join(out, 'failure.png') })
  await writeFile(
    path.join(out, 'failure.json'),
    JSON.stringify({ message: error.message, geometry: await geometry(page) }, null, 2)
  )
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
}
