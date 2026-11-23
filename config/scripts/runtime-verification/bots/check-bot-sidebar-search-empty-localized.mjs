// Bots search's empty lines with long translations at the 220px minimum sidebar: the message and its
// actions wrap instead of clipping, stay inside the held Bots section, and stay centered under the field.
// `--truncate` restores the old single-line truncation and must fail.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ensureFixtureServer } from '../../component-fixtures/fixture-server-client.mjs'

const outIndex = process.argv.indexOf('--out')
const out = path.resolve(
  outIndex === -1 ? '.cache/bot-search-empty-localized' : process.argv[outIndex + 1]
)
const truncate = process.argv.includes('--truncate')
const { url } = await ensureFixtureServer()
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 })
page.setDefaultTimeout(60_000)
const paint = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )

// Plausible long translations; the shipped catalogs fall back to English for these keys today.
const STRINGS = {
  en: {},
  de: {
    'bots.search.noMatches': 'Keine Bots entsprechen dieser Suche',
    'bots.search.clear': 'Suche zurücksetzen',
    'bots.search.pausedMatches_one': '{{count}} pausierter Bot entspricht der Suche',
    'bots.search.pausedMatches_other': '{{count}} pausierte Bots entsprechen der Suche',
    'bots.search.show': 'Anzeigen'
  },
  ru: {
    'bots.search.noMatches': 'Нет ботов, соответствующих этому запросу',
    'bots.search.clear': 'Очистить поиск',
    'bots.search.pausedMatches_one': '{{count}} приостановленный бот соответствует запросу',
    'bots.search.pausedMatches_other': '{{count}} приостановленных ботов соответствуют запросу',
    'bots.search.show': 'Показать'
  }
}

function measure() {
  return page.evaluate(() => {
    const split = document.querySelector('[data-sidebar-bots-split]').getBoundingClientRect()
    const row = document.querySelector('input[type=search]').parentElement.getBoundingClientRect()
    const line = document.querySelector(
      '[data-bot-sidebar-search] .bot-sidebar-scrollbar > div:last-child'
    )
    const box = line.getBoundingClientRect()
    return {
      inside:
        box.left >= split.left - 0.5 &&
        box.right <= split.right + 0.5 &&
        box.top >= row.bottom - 0.5 &&
        box.bottom <= split.bottom + 0.5,
      offsetFromMiddle: (box.top + box.bottom) / 2 - (row.bottom + split.bottom) / 2,
      clipped: [...line.querySelectorAll('span, button')].some(
        (element) => element.scrollWidth > element.clientWidth + 1
      ),
      lineHeight: box.height,
      text: line.innerText.replace(/\s+/g, ' ').trim()
    }
  })
}

const results = []
try {
  for (const theme of ['light', 'dark']) {
    for (const [lang, strings] of Object.entries(STRINGS)) {
      for (const [fixture, query, state] of [
        ['savedHeightOpenEmpty', 'zzz', 'no-matches'],
        ['shortListOpenEmpty', 'old', 'paused-only']
      ]) {
        await page.goto(`${url}/fixtures.html?id=bots/BotSidebarSearch:${fixture}&theme=${theme}`)
        await page.waitForFunction(() => document.documentElement.dataset.fixtureState === 'ready')
        await page.evaluate(
          async ({ strings, paused }) => {
            const frame = document.querySelector('#component-fixture-frame')
            Object.assign(frame.style, { padding: '0', width: '220px' })
            const { i18n } = await import('/src/i18n/i18n.ts')
            for (const [key, value] of Object.entries(strings)) {
              i18n.addResource(i18n.language, 'translation', key, value)
            }
            if (paused) {
              const { useAppStore } = await import('/src/store/index.ts')
              useAppStore.setState({
                botSidebarView: { ...useAppStore.getState().botSidebarView, hidePausedBots: true }
              })
            }
          },
          { strings, paused: state === 'paused-only' }
        )
        await page.locator('input[type=search]').fill(query)
        await paint()
        if (truncate) {
          await page.addStyleTag({
            content:
              '[data-bot-sidebar-search] .bot-sidebar-scrollbar > div { flex-wrap: nowrap !important } [data-bot-sidebar-search] .bot-sidebar-scrollbar > div > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap }'
          })
          await paint()
        }
        const m = await measure()
        const name = `${lang}-${state}-220px-${theme}`
        await page
          .locator('#component-fixture-frame')
          .screenshot({ path: path.join(out, `${name}.png`) })
        assert.ok(!m.clipped, `${name}: every word shows: ${m.text}`)
        assert.ok(m.inside, `${name}: the line fits inside the Bots section under the field`)
        assert.ok(Math.abs(m.offsetFromMiddle) <= 3, `${name}: centered (${m.offsetFromMiddle})`)
        results.push({ name, ...m })
      }
    }
  }
  await writeFile(path.join(out, 'geometry.json'), JSON.stringify({ results }, null, 2))
  console.log(`PASS: ${results.length} localized empty-line cases at the minimum sidebar width`)
} catch (error) {
  await writeFile(
    path.join(out, 'failure.json'),
    JSON.stringify({ message: error.message, results }, null, 2)
  )
  console.error(error)
  process.exitCode = 1
} finally {
  await browser.close()
}
