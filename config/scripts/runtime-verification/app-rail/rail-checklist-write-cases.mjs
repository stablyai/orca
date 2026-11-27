import assert from 'node:assert/strict'
import { paint, renderFixture } from './rail-fixture-evidence.mjs'

export async function hoverCarriedMoreSibling(page, label, results) {
  const submenu = page.locator('[data-slot="dropdown-menu-sub-content"]')
  const row = submenu.getByRole('menuitemcheckbox', { name: 'Automations', exact: true })
  assert.ok(
    await row.isVisible(),
    'the carried Automations checklist row is visible before arrival'
  )
  const sibling = page
    .locator('[data-slot="dropdown-menu-content"]')
    .getByRole('menuitem', { name: 'Automations', exact: true })
  await page.mouse.move(760, 500)
  assert.ok(await row.isVisible(), 'the carried checklist is still visible before entering More')
  const point = await sibling.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const x = Math.round(rect.x + rect.width / 2)
    const y = Math.round(rect.y + rect.height / 2)
    window.__moreArrival = null
    node.addEventListener(
      'pointermove',
      (event) => {
        window.__moreArrival = {
          trusted: event.isTrusted,
          type: event.pointerType,
          target: event.target.closest('[role="menuitem"]') === node,
          x: event.clientX,
          y: event.clientY,
          sibling: node.textContent.trim()
        }
      },
      { once: true }
    )
    return {
      x,
      y,
      hitsSibling: document.elementFromPoint(x, y)?.closest('[role="menuitem"]') === node
    }
  })
  assert.ok(point.hitsSibling, 'the aim point hits the Automations sibling in More')
  await page.mouse.move(point.x, point.y)
  const arrival = await page.evaluate(() => window.__moreArrival)
  results.push(
    `${label}: carried checklist visible before pointer arrival; arrival ${JSON.stringify(arrival)}`
  )
  assert.deepEqual(
    arrival,
    {
      trusted: true,
      type: 'mouse',
      target: true,
      x: point.x,
      y: point.y,
      sibling: 'Automations'
    },
    'trusted mouse reaches the exact More sibling'
  )
  await page.waitForTimeout(300)
  await paint(page)
  const stillOpen = await submenu.getByRole('menuitemcheckbox').count()
  results.push(`${label}: ${stillOpen} checklist rows after arriving on the sibling`)
  assert.equal(stillOpen, 5, `${label}: arriving on the More sibling keeps the reopened checklist`)
}

export async function checkChecklistWrites({
  page,
  url,
  only,
  flow,
  results,
  railItems,
  checklistFocus,
  clickRowAlongPath,
  pressSpaceOn,
  watchFrames,
  expectChecklistAfterSwap
}) {
  const TALL = 'workspaces,tasks,customize,account'
  const FOLDED_AUTOMATIONS = 'workspaces,tasks,more,account'
  const SUB = 'dropdown-menu-sub-content'
  const setup = async (fiveSlots = false) => {
    await renderFixture(page, url, 'fullRail', 'light', { width: 800, height: 600 })
    if (fiveSlots) {
      await page.locator('[role="toolbar"]').evaluate((toolbar) => {
        toolbar.closest('nav').parentElement.style.height = '202px'
      })
      await paint(page)
      await paint(page)
    }
    await page.locator('[data-app-rail-item="customize"]').focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menuitemcheckbox', { name: 'Automations', exact: true }).waitFor()
    await paint(page)
  }
  const waitForClosedMore = async () => {
    const trigger = page.locator('[data-app-rail-item="more"]')
    await trigger.waitFor()
    await paint(page)
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false', 'More stays collapsed')
    assert.equal(
      await page.locator('[data-slot="dropdown-menu-content"][data-state="open"]').count(),
      0
    )
    assert.equal(
      await page.getByRole('menuitemcheckbox').count(),
      0,
      'the swapped menu stays closed'
    )
  }
  async function holdNextWrite() {
    await page.evaluate(() => {
      const original = window.api.settings.set
      window.__checklistWrites = 0
      window.api.settings.set = (updates) => {
        window.__checklistWrites += 1
        return new Promise((resolve) => {
          window.__landChecklistWrite ??= async () => resolve(await original(updates))
        })
      }
    })
  }
  if (only !== 'publish') {
    await flow('carry: trusted second select during the first write', async () => {
      await setup()
      await holdNextWrite()
      await clickRowAlongPath('Automations')
      await page.waitForFunction(() => typeof window.__landChecklistWrite === 'function')
      const artifacts = page.getByRole('menuitemcheckbox', { name: 'Artifacts', exact: true })
      await artifacts.evaluate((node) => {
        window.__artifactsSelect = null
        let trustedClick = false
        node.addEventListener(
          'click',
          (event) => {
            trustedClick = event.isTrusted
          },
          { capture: true, once: true }
        )
        node.addEventListener(
          'menu.itemSelect',
          (event) => {
            const writesBeforeSelect = window.__checklistWrites
            // Radix dispatches this event before AppRail's onSelect. A prevented event confirms
            // that onSelect ran and called the toggle while the first bridge write was held.
            queueMicrotask(() => {
              window.__artifactsSelect = {
                row: node.textContent.trim(),
                trustedClick,
                selected: event.target === node && event.defaultPrevented,
                writesBeforeSelect,
                writesAfterSelect: window.__checklistWrites
              }
            })
          },
          { capture: true, once: true }
        )
      })
      await clickRowAlongPath('Artifacts')
      const select = await page.evaluate(() => window.__artifactsSelect)
      results.push(`Artifacts select with Automations held: ${JSON.stringify(select)}`)
      assert.ok(select, 'Artifacts reached the Radix select handler')
      assert.deepEqual(
        {
          row: select.row,
          trustedClick: select.trustedClick,
          selected: select.selected,
          writesBeforeSelect: select.writesBeforeSelect
        },
        { row: 'Artifacts', trustedClick: true, selected: true, writesBeforeSelect: 1 }
      )
      assert.equal(select.writesAfterSelect, 1, 'only Automations sends a settings write')
      await watchFrames()
      await page.evaluate(() => window.__landChecklistWrite())
      await expectChecklistAfterSwap('pending Automations write', {
        rail: FOLDED_AUTOMATIONS,
        row: 'Automations',
        checked: 'true',
        surface: SUB
      })
    })
  }

  if (only !== 'rapid') {
    await flow('carry: real fetch supersedes a held settings write', async () => {
      await setup()
      await page.evaluate(async () => {
        const { useAppStore } = await import('/src/store/index.ts')
        const original = useAppStore.getState().updateSettingsOrThrow
        const settings = useAppStore.getState().settings
        const probe = { events: [] }
        window.__publicationProbe = probe
        probe.read = () => ({
          showAutomations: useAppStore.getState().settings.showAutomationsButton,
          events: probe.events.slice()
        })
        window.api.settings.set = (updates) =>
          new Promise((resolve) => {
            probe.events.push('write held')
            probe.releaseWrite = () => {
              probe.events.push('write reply')
              resolve({ ...settings, ...updates })
            }
          })
        window.api.settings.get = () =>
          new Promise((resolve) => {
            probe.events.push('fetch held')
            probe.releaseFetch = () => {
              probe.events.push('fetch reply')
              resolve({ ...settings, showAutomationsButton: true })
            }
          })
        useAppStore.setState({
          updateSettingsOrThrow: (...args) => {
            // Forward to the real action and retain a promise for its acknowledgement settling.
            probe.write = original(...args).then(() => probe.events.push('write settled'))
            return probe.write
          }
        })
      })
      await pressSpaceOn('Automations')
      await page.waitForFunction(() => Boolean(window.__publicationProbe.releaseWrite))
      await page.evaluate(async () => {
        const { useAppStore } = await import('/src/store/index.ts')
        const probe = window.__publicationProbe
        probe.fetch = useAppStore
          .getState()
          .fetchSettings({
            deferOwnerWorktreeVisibilityDefaults: true
          })
          .then(() => probe.events.push('fetch settled'))
      })
      await page.waitForFunction(() => Boolean(window.__publicationProbe.releaseFetch))
      const stale = await page.evaluate(async () => {
        const probe = window.__publicationProbe
        probe.releaseWrite()
        await probe.write
        return probe.read()
      })
      await paint(page)
      const stillCustomize = await railItems()
      const staleFocus = await checklistFocus()
      results.push(
        `after stale reply: ${JSON.stringify({ ...stale, rail: stillCustomize, focus: staleFocus?.row })}`
      )
      assert.deepEqual(stale, {
        showAutomations: false,
        events: ['write held', 'fetch held', 'write reply', 'write settled']
      })
      assert.equal(stillCustomize, TALL, 'the original write did not publish the layout')
      assert.equal(staleFocus?.row, 'Automations', 'the original checklist still owns focus')

      await page.evaluate(async () => {
        const probe = window.__publicationProbe
        probe.releaseFetch()
        await probe.fetch
      })
      const more = page.locator('[data-app-rail-item="more"]')
      await more.waitFor()
      const moreNode = await more.elementHandle()
      await paint(page)
      await paint(page)
      const publication = await moreNode.evaluate((node) => ({
        ...window.__publicationProbe.read(),
        exactMoreOwnsFocus: document.activeElement === node && node.isConnected,
        expanded: node.getAttribute('aria-expanded'),
        checklistRows: document.querySelectorAll('[role="menuitemcheckbox"]').length
      }))
      results.push(`after matching fetch: ${JSON.stringify(publication)}`)
      assert.equal(await railItems(), FOLDED_AUTOMATIONS)
      assert.deepEqual(
        publication,
        {
          showAutomations: true,
          events: [
            'write held',
            'fetch held',
            'write reply',
            'write settled',
            'fetch reply',
            'fetch settled'
          ],
          exactMoreOwnsFocus: true,
          expanded: 'false',
          checklistRows: 0
        },
        'the matching fetch folds the rail without carrying the stale checkbox'
      )
    })
  }

  if (only === 'rapid' || only === 'publish') {
    return
  }
  await flow('carry: toggle in place, navigate to Artifacts, then resize', async () => {
    await setup(true)
    const rootMenu = page.locator('[data-slot="dropdown-menu-content"]')
    // Measure the positioned wrapper. The menu inside it is still running its opening transform.
    const menuTop = () =>
      rootMenu.evaluate(
        (menu) => menu.closest('[data-radix-popper-content-wrapper]').getBoundingClientRect().top
      )
    const openedTop = await menuTop()
    await pressSpaceOn('Automations')
    await page.locator('[data-app-rail-item="automations"]').waitFor()
    assert.equal(await railItems(), 'workspaces,tasks,automations,customize,account')
    await paint(page)
    const toggledTop = await menuTop()
    assert.ok(
      Math.abs(toggledTop - openedTop) <= 1,
      `the open menu held its position (${openedTop}px → ${toggledTop}px)`
    )
    await page.keyboard.press('ArrowDown')
    await page
      .getByRole('menuitemcheckbox', { name: 'Artifacts', exact: true })
      .and(page.locator(':focus'))
      .waitFor()
    await page.locator('[role="toolbar"]').evaluate((toolbar) => {
      toolbar.closest('nav').parentElement.style.height = '164px'
    })
    await waitForClosedMore()
  })
  await flow('carry: rejected write, then matching external publication', async () => {
    await setup()
    await page.evaluate(() => {
      window.api.settings.set = async () => {
        throw new Error('fixture intentionally rejected the write')
      }
    })
    const rejected = page.waitForEvent('console', {
      predicate: (message) => message.text().includes('fixture intentionally rejected the write')
    })
    await pressSpaceOn('Automations')
    await rejected
    await page.evaluate(async () => {
      const { useAppStore } = await import('/src/store/index.ts')
      useAppStore.setState((state) => ({
        settings: { ...state.settings, showAutomationsButton: true }
      }))
    })
    await waitForClosedMore()
  })
  await flow('carry: dismiss while write is pending, then acknowledge', async () => {
    await setup()
    await holdNextWrite()
    await pressSpaceOn('Automations')
    await page.waitForFunction(() => typeof window.__landChecklistWrite === 'function')
    await page.keyboard.press('Escape')
    await page.locator('[role="menu"]').waitFor({ state: 'hidden' })
    await page.evaluate(() => window.__landChecklistWrite())
    await waitForClosedMore()
  })
}
