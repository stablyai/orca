import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { ensureFixtureServer } from '../../component-fixtures/fixture-server-client.mjs'
import { geometry, checkRows, checkShell } from './bot-sidebar-search-layout-observations.mjs'

const outIndex = process.argv.indexOf('--out')
const out = path.resolve(outIndex === -1 ? '.cache/bot-search-reflow' : process.argv[outIndex + 1])
const { url } = await ensureFixtureServer()
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
page.setDefaultTimeout(60_000)
page.on('pageerror', (error) => console.error(error.message))
const results = []
const hideOuterOverflow = process.argv.includes('--hide-outer-overflow')
const field = page.locator('input[type=search]')
const viewport = page.locator('[data-sidebar-content-viewport]')
const paint = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )

async function render(name, theme) {
  await page.goto(`${url}/fixtures.html?id=bots/BotSidebarSearch:${name}&theme=${theme}`)
  await page.waitForFunction(() =>
    ['ready', 'error'].includes(document.documentElement.dataset.fixtureState)
  )
  assert.equal(await page.getAttribute('html', 'data-fixture-state'), 'ready')
  await field.focus()
}

async function snapshot(name) {
  await paint()
  const g = await geometry(page)
  await page.locator('#component-fixture-frame').screenshot({ path: path.join(out, `${name}.png`) })
  return g
}

async function checkContained() {
  await page.waitForFunction(() => {
    const viewport = document
      .querySelector('[data-sidebar-content-viewport]')
      .getBoundingClientRect()
    const field = document.querySelector('input[type=search]')
    const handle = document
      .querySelector('[data-sidebar-bots-resize-handle]')
      .getBoundingClientRect()
    return (
      document.activeElement === field &&
      field.getBoundingClientRect().top - 3 >= viewport.top &&
      handle.bottom <= viewport.bottom
    )
  })
  const g = await geometry(page)
  checkRows(g)
  checkShell(g, false)
  assert.ok(g.rows[1].box.bottom <= g.scroller.bottom, 'two complete results still fit')
}

async function growNav() {
  const before = await page
    .locator('[data-contextual-tour-target=sidebar-navigation]')
    .boundingBox()
  await page.evaluate(async () => {
    const { useAppStore } = await import('/src/store/index.ts')
    useAppStore.setState({
      settings: {
        ...useAppStore.getState().settings,
        showArtifactsButton: true,
        showSkillsButton: true,
        experimentalAgentDashboardPopout: true
      }
    })
  })
  await page.locator('[data-contextual-tour-target=agents-sidebar]').waitFor()
  await paint()
  const after = await page.locator('[data-contextual-tour-target=sidebar-navigation]').boundingBox()
  assert.ok(after.height > before.height, 'real optional navigation entries grew')
}

async function projectVisibility() {
  return page.locator('[data-worktree-id="wt-1"]').evaluate((element) => {
    const row = element.getBoundingClientRect()
    const inner = element.closest('[data-worktree-sidebar]').getBoundingClientRect()
    const outer = element.closest('[data-sidebar-content-viewport]').getBoundingClientRect()
    return {
      row: row.toJSON(),
      inner: inner.toJSON(),
      outer: outer.toJSON(),
      visible:
        row.top >= Math.max(inner.top, outer.top) &&
        row.bottom <= Math.min(inner.bottom, outer.bottom)
    }
  })
}

try {
  for (const theme of ['light', 'dark']) {
    await render('longListMinimumHeightResults', theme)
    for (const height of [400, 386]) {
      await page.locator('[data-sidebar-window]').evaluate((element, value) => {
        element.style.height = `${value}px`
      }, height)
      await checkContained()
      results.push({
        name: `resize-${height}-${theme}`,
        geometry: await snapshot(`resize-${height}-${theme}`)
      })
    }
    await growNav()
    await checkContained()
    results.push({ name: `nav-growth-${theme}`, geometry: await snapshot(`nav-growth-${theme}`) })

    await render('longListSmallestWindow', theme)
    if (hideOuterOverflow) {
      await viewport.evaluate((element) => {
        element.style.overflowY = 'hidden'
      })
    }
    const beforeWheel = await viewport.evaluate((element) => element.scrollTop)
    await page.locator('[data-sidebar-section-fold=bots]').hover()
    await page.mouse.wheel(0, 100)
    await page.waitForFunction(
      (top) => document.querySelector('[data-sidebar-content-viewport]').scrollTop > top,
      beforeWheel
    )
    await viewport.evaluate((element) =>
      element.scrollTo({ top: element.scrollHeight, behavior: 'instant' })
    )
    await paint()
    assert.ok(
      await field.evaluate((element) => element === document.activeElement),
      'deliberate scroll keeps focus in search'
    )
    const intentional = await viewport.evaluate((element) => element.scrollTop)
    await growNav()
    await paint()
    assert.equal(
      await viewport.evaluate((element) => element.scrollTop),
      intentional,
      'nav growth does not undo intentional Projects scrolling'
    )
    results.push({
      name: `intentional-scroll-${theme}`,
      geometry: await snapshot(`intentional-scroll-${theme}`)
    })

    await render('longListBeforeProjectReveal', theme)
    await page.locator('[data-worktree-id="wt-1"]').waitFor({ state: 'attached' })
    const before = await projectVisibility()
    assert.equal(before.visible, false, 'mounted target starts clipped by outer viewport')
    await page.getByRole('button', { name: 'Reveal current', exact: true }).click()
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-worktree-id="wt-1"]').getBoundingClientRect()
      const outer = document
        .querySelector('[data-sidebar-content-viewport]')
        .getBoundingClientRect()
      return row.top >= outer.top && row.bottom <= outer.bottom
    })
    assert.ok((await projectVisibility()).visible, 'toolbar reveals the actual Projects row')
    results.push({
      name: `toolbar-reveal-${theme}`,
      before,
      after: await projectVisibility(),
      geometry: await snapshot(`toolbar-reveal-${theme}`)
    })

    await field.focus()
    await checkContained()
    await page.evaluate(async () => {
      const { requestScrollToCurrentWorkspaceReveal } =
        await import('/src/lib/workspace/navigation/scroll-to-current-workspace-status.ts')
      requestScrollToCurrentWorkspaceReveal()
    })
    await page.waitForFunction(() => {
      const row = document.querySelector('[data-worktree-id="wt-1"]').getBoundingClientRect()
      const outer = document
        .querySelector('[data-sidebar-content-viewport]')
        .getBoundingClientRect()
      return row.top >= outer.top && row.bottom <= outer.bottom
    })
    assert.ok(
      (await projectVisibility()).visible,
      'public reveal overrides outer position while search stays focused'
    )
    results.push({
      name: `public-reveal-${theme}`,
      geometry: await snapshot(`public-reveal-${theme}`)
    })
  }
  await writeFile(
    path.join(out, 'geometry.json'),
    JSON.stringify({ browser: browser.version(), results }, null, 2)
  )
  console.log(
    `PASS: ${results.length} reflow, nav growth, intentional scroll and actual Projects reveal cases`
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
