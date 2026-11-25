// Usage: node config/scripts/runtime-verification/app-rail/check-rail-menus-close-focus-and-scroll.mjs [--out dir]
//          [--only focus|scroll]
// Tears down the fixture server and browser it starts (see rail-proof-session.mjs); a preexisting server is reused.
// Focus (RC-C1-03): keyboard-open the rail's "…" and More on a stable-capacity Workspaces rail, close them, and check
//   where focus lands: a trusted click on a hit-tested blank point, root Escape, and More with Customize open all
//   return focus to the exact trigger node; a click into an outside input, and an outside control that takes focus
//   before the recovery frame runs, keep it.
// Scroll (RC-C1-04): in a window too short for the checklist, "…" and More > Customize fit the window and scroll with
//   trusted wheel input both ways; the first and last rows can be hit and toggled; the keyboard reaches and toggles all
//   five rows; More stays on the rail.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { paint, renderFixture, runRailProof } from './rail-proof-session.mjs'

const argValue = (flag) => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? null : process.argv[index + 1]
}
const out = path.resolve(argValue('--out') ?? '.cache/app-rail-menus')
const only = argValue('--only')
const SOURCES = [
  'src/components/app-rail/AppRailCustomizeMenu.tsx',
  'src/components/app-rail/AppRailMoreMenu.tsx'
]
const ROW_NAMES = ['Tasks', 'Automations', 'Artifacts', 'Skills', 'Orca Mobile']

await runRailProof('check-rail-menus-close-focus-and-scroll', async ({ page, url, served }) => {
  await mkdir(out, { recursive: true })
  const before = await served(SOURCES)
  for (const line of before.lines) {
    console.log(`[served] ${line}`)
  }
  const results = []
  const failures = []
  async function check(name, run) {
    try {
      const detail = await run()
      results.push(`PASS ${name}${detail ? `: ${detail}` : ''}`)
    } catch (error) {
      results.push(`FAIL ${name}: ${error instanceof Error ? error.message.split('\n')[0] : error}`)
      failures.push(name)
    }
  }
  const railItems = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-app-rail-item]'), (element) =>
        element.getAttribute('data-app-rail-item')
      ).join(',')
    )
  const describeFocus = () =>
    page.evaluate(() => {
      const active = document.activeElement
      if (!active || active === document.body) {
        return 'body'
      }
      return (
        active.getAttribute('data-app-rail-item') ??
        active.getAttribute('aria-label') ??
        `${active.tagName}[${active.getAttribute('role')}]`
      )
    })
  const triggerHasFocus = () =>
    page.evaluate(() => document.activeElement === Reflect.get(window, '__trigger'))
  const menusGone = () =>
    page.waitForFunction(() => document.querySelector('[role=menu]') === null, null, {
      polling: 50
    })
  // Radix restores close focus in a timeout after the menu unmounts and the fallback runs a frame after that.
  const settleFocus = async () => {
    await menusGone()
    await page.waitForTimeout(50)
    await paint(page)
    await paint(page)
  }

  async function workspacesRail(fixture, theme, viewport) {
    await renderFixture(page, url, fixture, theme, viewport)
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/store/index.ts')
      useAppStore.setState({ activeView: 'terminal', sidebarBody: 'workspaces' })
    })
    await paint(page)
    assert.equal(
      await page.getAttribute('[data-app-rail-item="workspaces"]', 'aria-current'),
      'page',
      'Workspaces is active'
    )
  }

  async function keyboardOpen(item) {
    await page.evaluate(
      (id) =>
        Reflect.set(window, '__trigger', document.querySelector(`[data-app-rail-item="${id}"]`)),
      item
    )
    await page.locator(`[data-app-rail-item="${item}"]`).focus()
    await page.keyboard.press('Enter')
    await page.locator('[role=menu]').first().waitFor()
    await paint(page)
  }

  async function openMoreCustomize() {
    await page.locator('[data-slot="dropdown-menu-sub-trigger"]', { hasText: 'Customize' }).focus()
    await page.keyboard.press('ArrowRight')
    await page.locator('[data-slot="dropdown-menu-sub-content"]').waitFor()
    await paint(page)
  }

  // The first candidate point with nothing focusable or menu-owned under it: the sidebar column's corner, else the
  // page's corner (an open submenu can cover the column).
  async function blankPoint() {
    const frame = await page.locator('#component-fixture-frame').boundingBox()
    assert.ok(frame)
    const viewport = page.viewportSize()
    const candidates = [
      { x: frame.x + frame.width - 20, y: frame.y + frame.height - 20 },
      { x: viewport.width - 20, y: viewport.height - 20 }
    ]
    const hits = []
    for (const point of candidates) {
      const hit = await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y)
        return {
          tag: element ? `${element.tagName}.${element.className}`.slice(0, 60) : null,
          blank:
            element !== null &&
            element.closest('[role=menu], button, input, a, [tabindex], [data-app-rail-item]') ===
              null
        }
      }, point)
      hits.push(hit)
      if (hit.blank) {
        return { ...point, hit: hit.tag }
      }
    }
    throw new Error(`no blank click point: ${JSON.stringify(hits)}`)
  }

  if (only !== 'scroll') {
    for (const theme of ['light', 'dark']) {
      for (const [fixture, item] of [
        ['tall', 'customize'],
        ['shortFolded', 'more']
      ]) {
        const label = `${theme} ${item}`
        const viewport = { width: 800, height: 600 }

        await check(
          `focus ${label}: trusted click on blank space returns to the trigger`,
          async () => {
            await workspacesRail(fixture, theme, viewport)
            const rail = await railItems()
            await keyboardOpen(item)
            const point = await blankPoint()
            await page.mouse.click(point.x, point.y)
            await settleFocus()
            assert.equal(await railItems(), rail, 'capacity stayed stable')
            assert.ok(await triggerHasFocus(), `focus on ${await describeFocus()}`)
            return `clicked ${point.hit} at ${Math.round(point.x)},${Math.round(point.y)}; focus on ${await describeFocus()} (same node)`
          }
        )

        await check(`focus ${label}: root Escape returns to the trigger`, async () => {
          await workspacesRail(fixture, theme, viewport)
          await keyboardOpen(item)
          await page.keyboard.press('Escape')
          await settleFocus()
          assert.ok(await triggerHasFocus(), `focus on ${await describeFocus()}`)
          return `focus on ${await describeFocus()} (same node)`
        })

        if (item === 'more') {
          await check(
            `focus ${label}: blank click with Customize open returns to More`,
            async () => {
              await workspacesRail(fixture, theme, viewport)
              await keyboardOpen(item)
              await openMoreCustomize()
              const point = await blankPoint()
              await page.mouse.click(point.x, point.y)
              await settleFocus()
              assert.ok(await triggerHasFocus(), `focus on ${await describeFocus()}`)
              return `focus on ${await describeFocus()} (same node)`
            }
          )
        }

        await check(`focus ${label}: a click into an outside input keeps focus there`, async () => {
          await workspacesRail(fixture, theme, viewport)
          await page.locator('.w-\\[220px\\]').evaluate((sidebar) => {
            sidebar.innerHTML = '<input aria-label="outside field" style="margin:20px;width:150px">'
          })
          await keyboardOpen(item)
          await page.getByLabel('outside field').click()
          await settleFocus()
          assert.equal(await describeFocus(), 'outside field')
          return 'focus on outside field'
        })

        await check(
          `focus ${label}: an outside control focused before the recovery frame keeps focus`,
          async () => {
            await workspacesRail(fixture, theme, viewport)
            await page.locator('.w-\\[220px\\]').evaluate((sidebar) => {
              sidebar.innerHTML = '<button aria-label="outside control">x</button>'
            })
            await keyboardOpen(item)
            // When the fallback asks for its frame, an outside control takes focus before that frame runs.
            await page.evaluate(() => {
              const realRequest = window.requestAnimationFrame.bind(window)
              const probe = { requested: false, ran: false, focusWhenRun: null }
              Reflect.set(window, '__recoveryProbe', probe)
              window.requestAnimationFrame = (callback) => {
                const source = String(callback)
                if (
                  !probe.requested &&
                  source.includes('isConnected') &&
                  source.includes('trigger')
                ) {
                  probe.requested = true
                  queueMicrotask(() =>
                    document.querySelector('[aria-label="outside control"]')?.focus()
                  )
                  return realRequest((time) => {
                    probe.focusWhenRun = document.activeElement?.getAttribute('aria-label') ?? null
                    callback(time)
                    probe.ran = true
                  })
                }
                return realRequest(callback)
              }
            })
            const point = await blankPoint()
            await page.mouse.click(point.x, point.y)
            await settleFocus()
            const probe = await page.evaluate(() => Reflect.get(window, '__recoveryProbe'))
            assert.ok(
              probe.requested && probe.ran,
              `the recovery frame ran: ${JSON.stringify(probe)}`
            )
            assert.equal(probe.focusWhenRun, 'outside control', 'the control had focus first')
            assert.equal(await describeFocus(), 'outside control')
            return `recovery frame ran with the control focused; focus stays on outside control`
          }
        )
      }
    }
  }

  // The open menu fits the window and is scrollable; trusted wheel input scrolls it down and back up.
  async function wheelBothWays(menu) {
    const box = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return {
        top: rect.top,
        bottom: rect.bottom,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        windowHeight: window.innerHeight
      }
    })
    assert.ok(
      box.top >= 0 && box.bottom <= box.windowHeight,
      `fits the window: ${JSON.stringify(box)}`
    )
    assert.ok(box.scrollHeight > box.clientHeight, `taller than the window: ${JSON.stringify(box)}`)
    const offsets = [await menu.evaluate((element) => element.scrollTop)]
    await page.mouse.move(box.x, box.y)
    for (const deltaY of [400, -150]) {
      await page.mouse.wheel(0, deltaY)
      await page.waitForTimeout(150)
      await paint(page)
      offsets.push(await menu.evaluate((element) => element.scrollTop))
    }
    assert.ok(offsets[1] > offsets[0], `wheel down scrolls: ${offsets.join(' → ')}`)
    assert.ok(offsets[2] < offsets[1], `wheel up scrolls back: ${offsets.join(' → ')}`)
    return { box, offsets }
  }

  // Scroll a row into the menu's view with the wheel, hit-test its center, and click it.
  async function hitAndToggle(menu, name) {
    const row = menu.getByRole('menuitemcheckbox', { name, exact: true })
    for (let attempt = 0; attempt < 8; attempt++) {
      const visible = await row.evaluate((element) => {
        const rect = element.getBoundingClientRect()
        const menuRect = element.closest('[role=menu]').getBoundingClientRect()
        return rect.top >= menuRect.top && rect.bottom <= menuRect.bottom
      })
      if (visible) {
        break
      }
      const up = await row.evaluate(
        (element) =>
          element.getBoundingClientRect().top <
          element.closest('[role=menu]').getBoundingClientRect().top
      )
      await page.mouse.wheel(0, up ? -80 : 80)
      await page.waitForTimeout(120)
    }
    const rowBox = await row.boundingBox()
    assert.ok(rowBox)
    const point = { x: rowBox.x + rowBox.width / 2, y: rowBox.y + rowBox.height / 2 }
    const hit = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[role=menuitemcheckbox]')?.textContent?.trim(),
      point
    )
    assert.equal(hit, name, `the point hits ${name}`)
    const checked = await row.getAttribute('aria-checked')
    await page.mouse.click(point.x, point.y)
    await page.waitForFunction(
      ({ name, checked }) =>
        Array.from(document.querySelectorAll('[role=menuitemcheckbox]'))
          .find((element) => element.textContent?.trim() === name)
          ?.getAttribute('aria-checked') !== checked,
      { name, checked },
      { polling: 50 }
    )
    return `${name} ${checked} → ${await row.getAttribute('aria-checked')}`
  }

  // From the first row, the keyboard reaches every row (each scrolled into view) and Space toggles it off and on.
  async function keyboardAllRows(menu) {
    // Keyboard only: a cursor resting over a scrolling menu would move the highlight to the row under it.
    // The page's left margin, beside the fixture frame: never under a menu.
    await page.mouse.move(2, (page.viewportSize()?.height ?? 100) - 2)
    await menu.getByRole('menuitemcheckbox', { name: ROW_NAMES[0], exact: true }).focus()
    const log = []
    for (const [index, name] of ROW_NAMES.entries()) {
      const state = await page.evaluate(() => {
        const active = document.activeElement
        const rect = active.getBoundingClientRect()
        const menuRect = active.closest('[role=menu]').getBoundingClientRect()
        return {
          row: active.textContent?.trim(),
          checked: active.getAttribute('aria-checked'),
          inView: rect.top >= menuRect.top - 1 && rect.bottom <= menuRect.bottom + 1
        }
      })
      assert.equal(state.row, name, `keyboard reaches ${name}`)
      assert.ok(state.inView, `${name} is scrolled into view`)
      // Space twice: each row toggles both ways and the shown set ends where it started, so a folded rail stays
      // folded. Radix treats a Space within a second of the last typed key as type-ahead, so the second one waits.
      const flipped = state.checked === 'true' ? 'false' : 'true'
      for (const expected of [flipped, state.checked]) {
        await page.keyboard.press(' ')
        await page.waitForFunction(
          (checked) => document.activeElement?.getAttribute('aria-checked') === checked,
          expected,
          { polling: 50 }
        )
        await page.waitForTimeout(1100)
      }
      log.push(`${name} ${state.checked}→${flipped}→${state.checked}`)
      if (index < ROW_NAMES.length - 1) {
        await page.keyboard.press('ArrowDown')
        // Radix moves roving focus in a timeout after the key, so wait for it rather than read it at once.
        await page
          .waitForFunction(
            (next) => document.activeElement?.textContent?.trim() === next,
            ROW_NAMES[index + 1],
            { polling: 50, timeout: 5000 }
          )
          .catch(() => {})
      }
    }
    return log.join(', ')
  }

  if (only !== 'focus') {
    // Only Workspaces, "…" and the account button on the rail, so "…" sits near the top of a 120px window.
    const fewPages = {
      showTasksButton: false,
      showAutomationsButton: false,
      showArtifactsButton: false,
      showSkillsButton: false,
      showMobileButton: false
    }
    const openCustomizeMenu = async (theme) => {
      await renderFixture(page, url, 'tall', theme, { width: 400, height: 120 })
      await page.evaluate(async (overrides) => {
        const { useAppStore } = await import('/src/store/index.ts')
        useAppStore.setState({ settings: { ...useAppStore.getState().settings, ...overrides } })
      }, fewPages)
      await paint(page)
      await keyboardOpen('customize')
      return page.locator('[data-slot="dropdown-menu-content"]')
    }
    const openMoreSubmenu = async (theme) => {
      await renderFixture(page, url, 'shortFolded', theme, { width: 500, height: 130 })
      // Every page shown, so toggling the first and last rows off leaves enough folded that More stays.
      await page.evaluate(async () => {
        const { useAppStore } = await import('/src/store/index.ts')
        useAppStore.setState({
          settings: {
            ...useAppStore.getState().settings,
            showTasksButton: true,
            showAutomationsButton: true,
            showArtifactsButton: true,
            showSkillsButton: true,
            showMobileButton: true
          }
        })
      })
      await paint(page)
      await keyboardOpen('more')
      await openMoreCustomize()
      return page.locator('[data-slot="dropdown-menu-sub-content"]')
    }
    for (const theme of ['light', 'dark']) {
      for (const [label, open] of [
        ['"…" menu in a 120px window', openCustomizeMenu],
        ['More > Customize in a 130px window', openMoreSubmenu]
      ]) {
        await check(`scroll ${theme} ${label}: fits, wheel scrolls both ways`, async () => {
          const menu = await open(theme)
          const { box, offsets } = await wheelBothWays(menu)
          await page.screenshot({
            path: path.join(
              out,
              `${label.startsWith('More') ? 'more-customize' : 'customize-menu'}-short-${theme}.png`
            )
          })
          return `menu ${Math.round(box.top)}–${Math.round(box.bottom)} of ${box.windowHeight}px, scrollTop ${offsets.join(' → ')}`
        })
        await check(
          `scroll ${theme} ${label}: hit and toggle the first and last rows`,
          async () => {
            const menu = await open(theme)
            const first = await hitAndToggle(menu, ROW_NAMES[0])
            const last = await hitAndToggle(menu, ROW_NAMES.at(-1))
            const rail = await railItems()
            if (label.startsWith('More')) {
              assert.ok(rail.includes('more'), `More stays on the rail: ${rail}`)
            }
            return `${first}; ${last}; rail ${rail}`
          }
        )
        await check(
          `scroll ${theme} ${label}: keyboard reaches and toggles all five rows`,
          async () => {
            const menu = await open(theme)
            const log = await keyboardAllRows(menu)
            const rail = await railItems()
            if (label.startsWith('More')) {
              assert.ok(rail.includes('more'), `More stays on the rail: ${rail}`)
              assert.ok(await menu.isVisible(), 'More > Customize is still open')
            }
            return `${log}; rail ${rail}`
          }
        )
      }
    }
  }

  const after = await served(SOURCES)
  assert.deepEqual(after.lines, before.lines, 'the served sources did not change during the run')
  console.log(results.join('\n'))
  console.log(`screenshots in ${path.relative(process.cwd(), out)}`)
  assert.deepEqual(failures, [], `${failures.length} check(s) failed`)
})
