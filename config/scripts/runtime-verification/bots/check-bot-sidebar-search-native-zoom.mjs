import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright-core'
import { ensureFixtureServer } from '../../component-fixtures/fixture-server-client.mjs'
import { checkRevealTargets } from './bot-sidebar-reveal-target-checks.mjs'

const outIndex = process.argv.indexOf('--out')
const out = path.resolve(
  outIndex === -1 ? '.cache/bot-search-native-zoom' : process.argv[outIndex + 1]
)
await mkdir(out, { recursive: true })
const profile = await mkdtemp(path.join(out, 'profile-'))
const { url } = await ensureFixtureServer()
const require = createRequire(import.meta.url)
const env = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: require('electron'),
  args: [
    path.join(import.meta.dirname, 'bot-sidebar-native-zoom-window.cjs'),
    `--profile=${profile}`,
    `--fixture-url=${url}/fixtures.html?id=bots/BotSidebarSearch:longListBeforeProjectReveal&theme=light`
  ],
  env
})
const page = await app.firstWindow()
const cdp = await page.context().newCDPSession(page)
page.setDefaultTimeout(60_000)
const results = []
const paint = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
const native = () =>
  app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return {
      bounds: window.getBounds(),
      content: window.getContentBounds(),
      minimum: window.getMinimumSize(),
      level: window.webContents.getZoomLevel(),
      factor: window.webContents.getZoomFactor(),
      visible: window.isVisible(),
      focused: window.isFocused()
    }
  })
async function setup(theme) {
  await page.goto(
    `${url}/fixtures.html?id=bots/BotSidebarSearch:longListBeforeProjectReveal&theme=${theme}`
  )
  await page.waitForFunction(() => document.documentElement.dataset.fixtureState === 'ready')
  await page.evaluate(() => {
    window.api.ui.getZoomLevel = window.__orcaNativeZoom.get
    window.api.ui.setZoomLevel = window.__orcaNativeZoom.set
    const frame = document.querySelector('#component-fixture-frame')
    Object.assign(frame.style, { padding: '0', width: '220px' })
    document.querySelector('[data-sidebar-window]').style.height = '100dvh'
  })
  if (process.argv.includes('--retain-containment')) {
    await page.addStyleTag({
      content:
        '[data-bot-search-field-only] .bot-sidebar-scrollbar { overscroll-behavior-y: contain !important; }'
    })
  }
}
async function zoom(level) {
  await page.evaluate(async (value) => {
    const { applyUIZoom } = await import('/src/app-shell/chrome/ui-zoom.ts')
    applyUIZoom(value)
  }, level)
  const state = await native()
  assert.ok(Math.abs(state.level - level) < 0.001)
  await page.waitForFunction(({ height, factor }) => Math.abs(innerHeight - height / factor) <= 1, {
    height: state.content.height,
    factor: state.factor
  })
  await paint()
}
async function observe() {
  return page.evaluate(() => {
    const rect = (element) => element.getBoundingClientRect().toJSON()
    const field = document.querySelector('input[type=search]')
    const viewport = document.querySelector('[data-sidebar-content-viewport]')
    const scroller =
      document.querySelector('[data-bot-sidebar-search] .bot-sidebar-scrollbar') ??
      document.querySelector('[data-bot-sidebar-list]')
    return {
      field: rect(field),
      split: rect(document.querySelector('[data-sidebar-bots-split]')),
      viewport: rect(viewport),
      toolbar: rect(viewport.nextElementSibling),
      scroller: rect(scroller),
      innerScroll: scroller.scrollTop,
      innerMax: scroller.scrollHeight - scroller.clientHeight,
      handle: rect(document.querySelector('[data-sidebar-bots-resize-handle]')),
      scroll: viewport.scrollTop,
      activeIsField: document.activeElement === field,
      fieldOnly: document
        .querySelector('[data-sidebar-bots-split]')
        .hasAttribute('data-bot-search-field-only'),
      overscroll: getComputedStyle(scroller).overscrollBehaviorY,
      wheel: window.__botWheelHit,
      level: window.__orcaNativeZoom.get(),
      cssHeight: innerHeight
    }
  })
}
async function save(name, detail = {}) {
  await paint()
  const geometry = await observe()
  const capture = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(out, `${name}.png`), Buffer.from(capture.data, 'base64'))
  results.push({ name, native: await native(), geometry, ...detail })
  return geometry
}
async function visible(selector, margin = 0) {
  await page.waitForFunction(
    ({ selector, margin }) => {
      const row = document.querySelector(selector)?.getBoundingClientRect()
      const outer = document
        .querySelector('[data-sidebar-content-viewport]')
        .getBoundingClientRect()
      return row && row.top - margin >= outer.top - 0.1 && row.bottom + margin <= outer.bottom + 0.1
    },
    { selector, margin }
  )
}
async function wheelTo(selector) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const delta = await page.locator(selector).evaluate((element) => {
      const row = element.getBoundingClientRect()
      const outer = element.closest('[data-sidebar-content-viewport]').getBoundingClientRect()
      return {
        x: outer.right - 1,
        y: (outer.top + outer.bottom) / 2,
        distance:
          row.top >= outer.top && row.bottom <= outer.bottom
            ? 0
            : (row.top + row.bottom - outer.top - outer.bottom) / 2
      }
    })
    if (delta.distance === 0) {
      return
    }
    await page.mouse.move(delta.x, delta.y)
    await page.mouse.wheel(0, delta.distance)
    await paint()
  }
  await visible(selector)
}
function botsScroller(surface) {
  return page.locator(
    surface === 'results'
      ? '[data-bot-sidebar-search] .bot-sidebar-scrollbar'
      : '[data-bot-sidebar-list]'
  )
}
async function pointInside(scroller) {
  const pointer = await scroller.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const outer = element.closest('[data-sidebar-content-viewport]').getBoundingClientRect()
    const top = Math.max(box.top, outer.top)
    const bottom = Math.min(box.bottom, outer.bottom)
    return { x: box.left + box.width / 2, y: (top + bottom) / 2, visible: bottom > top }
  })
  assert.ok(pointer.visible, 'wheel starts over the visible Bots scroller')
  await page.mouse.move(pointer.x, pointer.y)
}
async function stationaryWheel(surface, theme) {
  const scroller = botsScroller(surface)
  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await paint()
  await pointInside(scroller)
  const before = await save(`stationary-before-${surface}-${theme}`)
  await scroller.evaluate((element) => {
    window.__botWheelHit = null
    document.addEventListener(
      'wheel',
      (event) => {
        window.__botWheelHit = {
          inside: element.contains(event.target),
          target: event.target.tagName,
          class: event.target.className,
          x: event.clientX,
          y: event.clientY,
          delta: event.deltaY
        }
      },
      { capture: true, passive: true, once: true }
    )
  })
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.mouse.wheel(0, 100)
    await paint()
    if ((await observe()).scroll > before.scroll) {
      break
    }
  }
  assert.ok(
    await page.evaluate(() => window.__botWheelHit.inside),
    'the native wheel lands inside the Bots scroller'
  )
  assert.ok(
    (await observe()).scroll > before.scroll,
    'wheel past the Bots endpoint advances the outer sidebar'
  )
  await save(`stationary-${surface === 'results' ? 'inner' : 'list'}-wheel-${theme}`, {
    before,
    wheel: await page.evaluate(() => window.__botWheelHit),
    outcome: 'Wheel at the Bots endpoint continues into the outer sidebar; pointer stays stationary'
  })
  for (const [name, selector] of [
    ['handle', '[data-sidebar-bots-resize-handle]'],
    ['projects', '[data-sidebar-section-fold=projects]']
  ]) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (
        await page.locator(selector).evaluate((element) => {
          const box = element.getBoundingClientRect()
          const outer = element.closest('[data-sidebar-content-viewport]').getBoundingClientRect()
          return box.top >= outer.top - 0.1 && box.bottom <= outer.bottom + 0.1
        })
      ) {
        break
      }
      await page.mouse.wheel(0, 8)
      await paint()
    }
    await visible(selector)
    await save(`stationary-wheel-${name}-${surface}-${theme}`)
  }
}
async function containedWheel(level, surface, theme) {
  await zoom(level)
  const field = page.locator('input[type=search]')
  await field.fill(surface === 'results' ? 'bot' : '')
  await field.focus()
  const scroller = botsScroller(surface)
  await scroller.waitFor({ state: 'visible' })
  await scroller.evaluate((element) => element.scrollTo({ top: element.scrollHeight }))
  await paint()
  await pointInside(scroller)
  const before = await observe()
  await page.mouse.wheel(0, 10000)
  await paint()
  await paint()
  const after = await observe()
  assert.equal(after.scroll, before.scroll, 'fitting split keeps the outer scroll position')
  assert.deepEqual(after.field, before.field, 'wheel past Bots does not move the fitting field')
  await save(`contained-${surface}-${level}-${theme}`, { before, after })
}
try {
  for (const theme of ['light', 'dark']) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800))
    await setup(theme)
    await zoom(0)
    await page.locator('input[type=search]').focus()
    assert.equal((await save(`normal-default-${theme}`)).scroll, 0)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 400))
    assert.equal((await native()).bounds.height, 400)
    for (const level of [-3, 0, 1, 1.5, 2, 2.5, 3, 4, 5, 4, 3, 2.5, 2, 1.5, 1, 0, -3]) {
      await zoom(level)
      await visible('input[type=search]', 3)
      const g = await observe()
      assert.ok(g.activeIsField, 'zoom transitions retain input focus')
      assert.ok(g.toolbar.bottom <= g.cssHeight, 'toolbar stays contained')
      if (level === 1.5) {
        assert.ok(g.handle.bottom <= g.viewport.bottom, 'full split fits at +1.5')
        assert.ok(
          g.split.top >= g.viewport.top - 0.1,
          'full header stays visible when the allocation fits'
        )
      }
      if (level === 2) {
        assert.ok(
          g.handle.bottom - g.split.top > g.viewport.height,
          'actual split extent exceeds the +2 allocation'
        )
      }
      assert.equal((await native()).bounds.height, 400)
      assert.equal((await native()).visible, false)
      results.push({ name: `focus-held-${level}-${theme}`, native: await native(), geometry: g })
      if (level === 5 || level === -3) {
        await save(`field-${level}-${theme}`)
      }
      if (level === 5 || level === 0) {
        await save(`focus-held-${level}-${theme}`)
      }
    }
    for (const level of [0, 1.5]) {
      for (const surface of ['results', 'list']) {
        await containedWheel(level, surface, theme)
      }
    }
    await page.locator('input[type=search]').fill('bot')
    await zoom(5)
    await page.locator('input[type=search]').focus()
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
    await visible('input[type=search]', 3)
    await save(`native-nav-growth-${theme}`)
    for (const level of [5, -3]) {
      await zoom(level)
      const field = page.locator('input[type=search]')
      await field.focus()
      const baseline = await observe()
      await field.press('ArrowDown')
      const rows = page.locator('[data-bot-search-result]')
      for (let index = 0; index < (await rows.count()); index++) {
        const id = await rows.nth(index).getAttribute('data-bot-search-result')
        assert.equal(
          await page.evaluate(() => document.activeElement?.getAttribute('data-bot-search-result')),
          id
        )
        await visible(`[data-bot-search-result="${id}"]`, 2)
        if (index + 1 < (await rows.count())) {
          await page.keyboard.press('ArrowDown')
        }
      }
      await save(`keyboard-last-result-${level}-${theme}`)
      await page.keyboard.press('Tab')
      assert.ok(
        await page
          .locator('[data-sidebar-bots-resize-handle]')
          .evaluate((element) => element === document.activeElement)
      )
      await visible('[data-sidebar-bots-resize-handle]')
      await page.keyboard.press('ArrowUp')
      assert.equal(
        await page.evaluate(async () => {
          const { useAppStore } = await import('/src/store/index.ts')
          return useAppStore.getState().sidebarBotsHeight
        }),
        80,
        'keyboard resize at the search floor retains the saved cap'
      )
      await save(`keyboard-handle-${level}-${theme}`)
      await page.keyboard.press('Tab')
      await visible('[data-sidebar-section-fold=projects]')
      await save(`keyboard-projects-header-${level}-${theme}`)
      for (let index = 0; index < 40; index++) {
        if (
          await page
            .locator('[data-worktree-sidebar]')
            .evaluate((element) => element === document.activeElement)
        ) {
          break
        }
        await page.keyboard.press('Tab')
      }
      assert.ok(
        await page
          .locator('[data-worktree-sidebar]')
          .evaluate((element) => element === document.activeElement)
      )
      await page.keyboard.press('ArrowDown')
      await visible('[data-worktree-id="wt-1"]')
      await save(`keyboard-project-row-${level}-${theme}`)
      await field.focus()
      await field.press('Tab')
      await page.keyboard.press('Tab')
      assert.ok(
        await rows.first().evaluate((element) => element === document.activeElement),
        'Tab enters first result'
      )
      await visible('[data-bot-search-result]', 2)
      if (level === 5) {
        await stationaryWheel('results', theme)
        await field.focus()
        const bar = await page.locator('[data-sidebar-content-viewport]').evaluate((element) => {
          const box = element.getBoundingClientRect()
          return {
            x: box.right - (box.width - element.clientWidth) / 2,
            y: box.bottom - 2,
            scroll: element.scrollTop
          }
        })
        await page.mouse.click(bar.x, bar.y)
        await page.waitForFunction(
          (top) => document.querySelector('[data-sidebar-content-viewport]').scrollTop !== top,
          bar.scroll
        )
        await save(`outer-scrollbar-click-${theme}`)
        await field.evaluate((element) => element.blur())
        await field.focus()
        await visible('input[type=search]', 3)
        await save(`refocus-after-scrollbar-${theme}`)
      }
      await field.focus()
      await wheelTo('[data-sidebar-bots-resize-handle]')
      await save(`wheel-handle-${level}-${theme}`)
      await wheelTo('[data-worktree-id="wt-1"]')
      await save(`wheel-project-${level}-${theme}`)
      await field.focus()
      await page.getByRole('button', { name: 'Reveal current', exact: true }).click()
      await visible('[data-worktree-id="wt-1"]')
      const after = await save(`explicit-project-${level}-${theme}`)
      assert.deepEqual(after.toolbar, baseline.toolbar, 'toolbar fixed through outer navigation')
      await field.focus()
      await visible('input[type=search]', 3)
      await page.evaluate(async () => {
        const { requestScrollToCurrentWorkspaceReveal } =
          await import('/src/lib/workspace/navigation/scroll-to-current-workspace-status.ts')
        requestScrollToCurrentWorkspaceReveal()
      })
      await visible('[data-worktree-id="wt-1"]')
      await save(`repeated-public-project-${level}-${theme}`)
    }
    await setup(theme)
    await zoom(5)
    await page.locator('input[type=search]').fill('')
    await botsScroller('list').waitFor({ state: 'visible' })
    await botsScroller('list').evaluate((element) =>
      element.scrollIntoView({ block: 'start', behavior: 'instant' })
    )
    await stationaryWheel('list', theme)
    await checkRevealTargets({
      page,
      theme,
      save,
      reset: async () => {
        await setup(theme)
        await zoom(5)
      }
    })
  }
  await writeFile(path.join(out, 'geometry.json'), JSON.stringify({ results }, null, 2))
  console.log(
    `PASS: native 400 DIP Electron zoom -3..+5, held focus, ArrowDown/Tab, wheel chaining/containment, explicit reveal and fixed toolbar (${results.length} observations)`
  )
} catch (error) {
  const capture = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(out, 'failure.png'), Buffer.from(capture.data, 'base64'))
  await writeFile(
    path.join(out, 'failure.json'),
    JSON.stringify(
      { message: error.message, native: await native(), geometry: await observe() },
      null,
      2
    )
  )
  console.error(error)
  process.exitCode = 1
} finally {
  await app.close()
}
