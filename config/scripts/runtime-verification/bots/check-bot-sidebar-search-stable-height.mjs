// Typing in Bots search must not resize the Bots section or move Projects: results, one result and
// the empty state all sit inside the box the field opened with. Results start at the top as a list;
// the no-match line sits in the middle of the box under the field. `--release-hold` drops the hold after
// opening and must fail, proving the check sees the jump.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ensureFixtureServer } from '../../component-fixtures/fixture-server-client.mjs'

const outIndex = process.argv.indexOf('--out')
const out = path.resolve(
  outIndex === -1 ? '.cache/bot-search-stable-height' : process.argv[outIndex + 1]
)
const releaseHold = process.argv.includes('--release-hold')
const { url } = await ensureFixtureServer()
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
page.setDefaultTimeout(60_000)
page.on('pageerror', (error) => console.error(error.message))
const field = page.locator('input[type=search]')
const toggle = page.locator('[data-bot-sidebar-search-toggle]')
const results = []
const paint = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )

/** What a user sees move: the section box, the field, Projects, and where the results end. */
function measure() {
  return page.evaluate(() => {
    const box = (element) => {
      if (!element) {
        return null
      }
      const { top, bottom, height } = element.getBoundingClientRect()
      return { top, bottom, height }
    }
    const results = document.querySelector('[data-bot-sidebar-search] .bot-sidebar-scrollbar')
    const empty = [...document.querySelectorAll('[data-bot-sidebar-search] button')].find(
      (button) => button.textContent === 'Clear search'
    )
    return {
      section: box(document.querySelector('[data-sidebar-bots-split]')),
      field: box(document.querySelector('input[type=search]')),
      fieldRow: box(document.querySelector('input[type=search]')?.parentElement ?? null),
      firstResult: box(document.querySelector('[data-bot-search-result]')),
      projects: box(document.querySelector('[data-sidebar-projects-list]')),
      results: box(results),
      empty: box(empty?.closest('.bot-sidebar-scrollbar > div') ?? null),
      count: document.querySelectorAll('[data-bot-search-result]').length
    }
  })
}

async function render(name, theme) {
  await page.goto(`${url}/fixtures.html?id=bots/BotSidebarSearch:${name}&theme=${theme}`)
  await page.waitForFunction(() =>
    ['ready', 'error'].includes(document.documentElement.dataset.fixtureState)
  )
  assert.equal(await page.getAttribute('html', 'data-fixture-state'), 'ready')
  await field.focus()
  if (releaseHold) {
    await page.evaluate(() => {
      document.querySelector('[data-sidebar-bots-split]').style.height = ''
    })
  }
  await paint()
}

/** Counts section resizes from here on, so a one-frame jump that settles back still fails. */
async function watchResizes() {
  await page.evaluate(() => {
    const section = document.querySelector('[data-sidebar-bots-split]')
    window.__botsSectionResizes = []
    let first = true
    const observer = new ResizeObserver(([entry]) => {
      if (first) {
        first = false
        return
      }
      window.__botsSectionResizes.push(entry.contentRect.height)
    })
    observer.observe(section)
    window.__stopBotsSectionWatch = () => observer.disconnect()
  })
  await paint()
}

async function resizes() {
  return page.evaluate(() => {
    window.__stopBotsSectionWatch()
    return window.__botsSectionResizes
  })
}

function sameBox(actual, expected, what) {
  assert.ok(actual && expected, `${what} is on screen`)
  for (const key of ['top', 'bottom', 'height']) {
    assert.ok(
      Math.abs(actual[key] - expected[key]) < 0.5,
      `${what} ${key} stays at ${expected[key]}, got ${actual[key]}`
    )
  }
}

function inside(inner, outer, what) {
  assert.ok(inner, `${what} is on screen`)
  assert.ok(
    inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5,
    `${what} fits inside the Bots section`
  )
}

async function shot(name) {
  await paint()
  await page.locator('#component-fixture-frame').screenshot({ path: path.join(out, `${name}.png`) })
}

try {
  for (const theme of ['light', 'dark']) {
    for (const [name, typing, one] of [
      ['longListOpenEmpty', 'bot 1', '8'],
      ['savedHeightOpenEmpty', 'bot 1', '8'],
      ['shortListOpenEmpty', 'r', 'el']
    ]) {
      await render(name, theme)
      const opened = await measure()
      await shot(`${name}-opened-${theme}`)
      await watchResizes()
      const steps = []
      // Typed key by key: many results, then fewer, one, none, and back to many.
      for (const [query, label] of [
        [typing, 'typing'],
        [one, 'one'],
        ['zz', 'none']
      ]) {
        for (const key of query) {
          await field.press(key === ' ' ? 'Space' : key)
          await paint()
          const now = await measure()
          sameBox(now.section, opened.section, `section after "${key}"`)
          sameBox(now.field, opened.field, `field after "${key}"`)
          sameBox(now.projects, opened.projects, `Projects after "${key}"`)
          if (now.results) {
            inside(now.results, now.section, 'results')
          }
          steps.push({ key, count: now.count })
        }
        await shot(`${name}-${label}-${theme}`)
        if (label === 'typing') {
          assert.ok((await measure()).count > 1, 'several results while typing')
        }
        if (label === 'one') {
          const one = await measure()
          assert.equal(one.count, 1, 'one result')
          assert.ok(
            one.firstResult.top - one.fieldRow.bottom < 2,
            'a lone result starts right under the field, as a list'
          )
        }
      }
      const none = await measure()
      assert.equal(none.count, 0)
      inside(none.empty, none.section, 'no-matches line')
      // Centered between the field row and the section's bottom edge; the list's 4px bottom inset allows 2px.
      const middle = (none.fieldRow.bottom + none.section.bottom) / 2
      const center = (none.empty.top + none.empty.bottom) / 2
      assert.ok(
        Math.abs(center - middle) <= 3,
        `no-matches line centered under the field: ${center} vs ${middle}`
      )
      for (let index = 0; index < `${typing}${one}zz`.length; index += 1) {
        await field.press('Backspace')
        await paint()
        sameBox((await measure()).section, opened.section, 'section while deleting')
      }
      assert.deepEqual(await resizes(), [], 'the section never resized while typing')
      steps.push({ key: 'cleared', count: (await measure()).count })

      // The first painted frame after a no-match first keystroke already has the line centered and the
      // list gone: no top-then-middle jump.
      await page.evaluate(() => {
        window.__noMatchFrames = []
        const sample = () => {
          const field = document.querySelector('input[type=search]')
          const section = document
            .querySelector('[data-sidebar-bots-split]')
            .getBoundingClientRect()
          const row = field.parentElement.getBoundingClientRect()
          const link = [...document.querySelectorAll('[data-bot-sidebar-search] button')].find(
            (button) => button.textContent === 'Clear search'
          )
          const line = link?.closest('.bot-sidebar-scrollbar > div').getBoundingClientRect()
          window.__noMatchFrames.push({
            value: field.value,
            offset: line ? (line.top + line.bottom) / 2 - (row.bottom + section.bottom) / 2 : null,
            listShown: !!document.querySelector('[data-bot-sidebar-list]')?.offsetParent
          })
          if (window.__noMatchFrames.length < 12) {
            requestAnimationFrame(sample)
          }
        }
        requestAnimationFrame(sample)
      })
      await field.press('z')
      await page.waitForFunction(() => window.__noMatchFrames.length >= 12)
      const typedFrames = await page.evaluate(() =>
        window.__noMatchFrames.filter((frame) => frame.value === 'z')
      )
      assert.ok(typedFrames.length > 0, 'frames recorded after the keystroke')
      for (const frame of typedFrames) {
        assert.ok(
          frame.offset !== null && Math.abs(frame.offset) <= 3 && !frame.listShown,
          `no-match line centered from the first frame: ${JSON.stringify(typedFrames)}`
        )
      }
      await field.press('Backspace')
      await paint()

      // Closing hands the height back to the list; opening again holds the same box.
      await field.press('Escape')
      await paint()
      const closed = await measure()
      await shot(`${name}-closed-${theme}`)
      await toggle.click()
      await paint()
      sameBox((await measure()).section, opened.section, 'section reopened')
      await field.press('Escape')
      await paint()
      sameBox((await measure()).section, closed.section, 'section closed again')
      results.push({ name, theme, opened: opened.section, closed: closed.section, steps })
    }
  }
  await writeFile(
    path.join(out, 'geometry.json'),
    JSON.stringify({ browser: browser.version(), results }, null, 2)
  )
  console.log(`PASS: ${results.length} stable-height cases`)
} catch (error) {
  await page.locator('#component-fixture-frame').screenshot({ path: path.join(out, 'failure.png') })
  await writeFile(
    path.join(out, 'failure.json'),
    JSON.stringify({ message: error.message, geometry: await measure() }, null, 2)
  )
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
}
