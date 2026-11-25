// Usage: node config/scripts/runtime-verification/app-rail/check-rail-menus-close-focus-and-scroll.mjs [--out dir]
// 1. Keyboard-open the rail's "…" (and More, when folded), click blank space: focus returns to the trigger, never body.
// 2. In a very short window, "…" and More > Customize scroll inside the window instead of clipping.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ensureFixtureServer } from '../../component-fixtures/fixture-server-client.mjs'

const outIndex = process.argv.indexOf('--out')
const out = path.resolve(outIndex === -1 ? '.cache/app-rail-menus' : process.argv[outIndex + 1])
const { url } = await ensureFixtureServer()
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
page.setDefaultTimeout(120_000)
page.on('pageerror', (error) => console.error(error.message))
const paint = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
const focused = () =>
  page.evaluate(() => {
    const active = document.activeElement
    return !active || active === document.body
      ? 'body'
      : (active.getAttribute('data-app-rail-item') ??
          `${active.tagName}[${active.getAttribute('role')}]`)
  })

async function render(name, theme, viewport, settings) {
  await page.setViewportSize(viewport)
  await page.goto(`${url}/fixtures.html?id=app-rail/AppRail:${name}&theme=${theme}`)
  await page.waitForFunction(() =>
    ['ready', 'error'].includes(document.documentElement.dataset.fixtureState)
  )
  assert.equal(await page.getAttribute('html', 'data-fixture-state'), 'ready')
  if (settings) {
    await page.evaluate(async (overrides) => {
      const { useAppStore } = await import('/src/store/index.ts')
      useAppStore.setState({ settings: { ...useAppStore.getState().settings, ...overrides } })
    }, settings)
    await paint()
  }
}

async function keyboardOpen(item) {
  await page.locator(`[data-app-rail-item="${item}"]`).focus()
  await page.keyboard.press('Enter')
  await page.locator('[role=menu]').first().waitFor()
  await paint()
}

// The open menu fits the window and its last row can be scrolled into view inside it.
async function checkFitsAndScrolls(menu, label, theme) {
  const box = await menu.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      top: rect.top,
      bottom: rect.bottom,
      overflows: element.scrollHeight > element.clientHeight,
      windowHeight: window.innerHeight
    }
  })
  assert.ok(
    box.top >= 0 && box.bottom <= box.windowHeight,
    `${label} stays in the window: ${JSON.stringify(box)}`
  )
  assert.ok(
    box.overflows,
    `${label} is taller than the window, so it must scroll: ${JSON.stringify(box)}`
  )
  const lastRow = menu.locator('[role=menuitemcheckbox]').last()
  await menu.evaluate((element) =>
    element.scrollTo({ top: element.scrollHeight, behavior: 'instant' })
  )
  await paint()
  const reachable = await lastRow.evaluate((row) => {
    const rect = row.getBoundingClientRect()
    const menuRect = row.closest('[role=menu]').getBoundingClientRect()
    return rect.top >= menuRect.top - 1 && rect.bottom <= menuRect.bottom + 1
  })
  assert.ok(reachable, `${label}'s last row scrolls into view`)
  await page.screenshot({ path: path.join(out, `${label}-short-${theme}.png`) })
}

const results = []
try {
  for (const theme of ['light', 'dark']) {
    for (const [fixture, item] of [
      ['tall', 'customize'],
      ['shortFolded', 'more']
    ]) {
      for (const [target, point] of [
        ['blank sidebar', (frame) => ({ x: frame.x + 200, y: frame.y + 40 })],
        ['blank page', () => ({ x: 780, y: 580 })]
      ]) {
        await render(fixture, theme, { width: 800, height: 600 })
        await keyboardOpen(item)
        const frame = await page.locator('#component-fixture-frame').boundingBox()
        const { x, y } = point(frame)
        await page.mouse.click(x, y)
        await page.locator('[role=menu]').first().waitFor({ state: 'detached' })
        // Radix runs close focus in a timeout after unmount; give it a beat, then read wherever focus settled.
        await page
          .waitForFunction(
            () => document.activeElement && document.activeElement !== document.body,
            null,
            {
              timeout: 1000
            }
          )
          .catch(() => {})
        const after = await focused()
        results.push(`${theme} ${item} → click ${target}: focus on ${after}`)
        assert.equal(after, item, `${item}: focus returns to its trigger after a blank-space click`)
      }

      // A click that focuses something else keeps that focus.
      await render(fixture, theme, { width: 800, height: 600 })
      await page.locator('.w-\\[220px\\]').evaluate((sidebar) => {
        sidebar.innerHTML = '<input aria-label="probe field" style="margin:20px;width:150px">'
      })
      await keyboardOpen(item)
      await page.getByLabel('probe field').click()
      await page.locator('[role=menu]').first().waitFor({ state: 'detached' })
      await page.waitForTimeout(200)
      const kept = await focused()
      results.push(`${theme} ${item} → click a text field: focus on ${kept}`)
      assert.equal(kept, 'INPUT[null]', `${item}: a click into a field keeps focus there`)
    }

    // Only Workspaces, "…", Help and Settings on the rail, so "…" sits near the top of a 120px window.
    const fewPages = {
      showTasksButton: false,
      showAutomationsButton: false,
      showArtifactsButton: false,
      showSkillsButton: false,
      showMobileButton: false
    }
    await render('tall', theme, { width: 400, height: 120 }, fewPages)
    await keyboardOpen('customize')
    await checkFitsAndScrolls(page.locator('[role=menu]').first(), 'customize-menu', theme)
    results.push(`${theme} "…" menu fits a 120px window and scrolls`)

    await render('shortFolded', theme, { width: 500, height: 130 })
    await keyboardOpen('more')
    const sub = page.locator('[data-slot="dropdown-menu-sub-trigger"]', { hasText: 'Customize' })
    await sub.focus()
    await page.keyboard.press('ArrowRight')
    const submenu = page.locator('[data-slot="dropdown-menu-sub-content"]')
    await submenu.waitFor()
    await paint()
    await checkFitsAndScrolls(submenu, 'more-customize-submenu', theme)
    results.push(`${theme} More > Customize fits a 130px window and scrolls`)
  }
  console.log(results.join('\n'))
  console.log(`PASS (screenshots in ${path.relative(process.cwd(), out)})`)
} catch (error) {
  console.log(results.join('\n'))
  throw error
} finally {
  await browser.close()
}
