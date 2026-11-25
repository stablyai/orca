// Usage: node config/scripts/runtime-verification/app-rail/check-rail-checklist-swap.mjs [--out dir] [--only c1-01|c1-02|carry]
// Runs against the `fullRail` fixture: Workspaces active, four slots, only Tasks shown, so one more page folds the rail.
// RC-C1-01: a Customize toggle that swaps "…" and More (both ways) keeps the checklist open on the toggled row, and a
//   second, different row changes without reopening: trusted mouse input along a real path, and Space on the row.
// RC-C1-02: focus on the closed "…"; Automations folds the rail (its focus recovery frame is held), then Artifacts
//   commits before that frame runs. The first frame must be canceled without running and the next one must focus the
//   same More node; an outside input focused between the two commits keeps focus instead.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { paint, renderFixture, runRailProof } from './rail-proof-session.mjs'

const argValue = (flag) => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? null : process.argv[index + 1]
}
const out = path.resolve(argValue('--out') ?? '.cache/app-rail-checklist-swap')
const only = argValue('--only')
const SOURCES = [
  'src/components/app-rail/AppRail.fixture.tsx',
  'src/components/app-rail/AppRail.tsx',
  'src/components/app-rail/AppRailCustomizeMenu.tsx',
  'src/components/app-rail/AppRailMoreMenu.tsx',
  'src/components/app-rail/app-rail-destinations.ts'
]

await runRailProof('check-rail-checklist-swap', async ({ page, url, served }) => {
  await mkdir(out, { recursive: true })
  const before = await served(SOURCES)
  for (const line of before.lines) {
    console.log(`[served] ${line}`)
  }
  const results = []
  const railItems = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-app-rail-item]'), (element) =>
        element.getAttribute('data-app-rail-item')
      ).join(',')
    )

  // Which checklist row has focus, its checked state, and the surface it lives in.
  const checklistFocus = () =>
    page.evaluate(() => {
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || active.getAttribute('role') !== 'menuitemcheckbox') {
        return null
      }
      const menu = active.closest('[role=menu]')
      return {
        row: active.textContent?.trim() ?? '',
        checked: active.getAttribute('aria-checked'),
        surface: menu?.getAttribute('data-slot') ?? null,
        rect: menu ? menu.getBoundingClientRect().toJSON() : null
      }
    })

  // Samples every frame from now until stopped: a frame with no checklist on screen would be a visible close/reopen.
  const watchFrames = () =>
    page.evaluate(() => {
      const watch = { frames: 0, withoutChecklist: 0, stop: false }
      window.__checklistWatch = watch
      const tick = () => {
        if (watch.stop) {
          return
        }
        watch.frames += 1
        if (!document.querySelector('[role=menuitemcheckbox]')) {
          watch.withoutChecklist += 1
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  const stopWatch = () =>
    page.evaluate(() => {
      const watch = window.__checklistWatch
      watch.stop = true
      return {
        frames: watch.frames,
        withoutChecklist: watch.withoutChecklist
      }
    })

  async function rowCenter(name) {
    const box = await page.getByRole('menuitemcheckbox', { name, exact: true }).boundingBox()
    assert.ok(box, `${name} row is on screen`)
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  // Trusted pointer input along a straight path (one pointermove per step), then a click on the row.
  async function clickRowAlongPath(name) {
    const { x, y } = await rowCenter(name)
    const hit = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[role=menuitemcheckbox]')?.textContent?.trim(),
      { x, y }
    )
    assert.equal(hit, name, `the point aimed at ${name} hits that row`)
    await page.mouse.move(x, y, { steps: 12 })
    await page.mouse.down()
    await page.mouse.up()
  }

  async function pressSpaceOn(name) {
    // Arrow keys from wherever the checklist's focus is to the named row, then Space on it.
    for (let step = 0; step < 6; step++) {
      const focus = await checklistFocus()
      if (focus?.row === name) {
        break
      }
      const rows = await page
        .locator('[role=menu]:has([role=menuitemcheckbox]:focus) [role=menuitemcheckbox]')
        .allTextContents()
      const from = rows.findIndex((row) => row.trim() === focus?.row)
      const to = rows.findIndex((row) => row.trim() === name)
      await page.keyboard.press(to > from ? 'ArrowDown' : 'ArrowUp')
      // Radix moves roving focus in a timeout after the key, so wait for it to leave the row it was on.
      await page
        .waitForFunction(
          (previous) => document.activeElement?.textContent?.trim() !== previous,
          focus?.row,
          { polling: 50, timeout: 5000 }
        )
        .catch(() => {})
    }
    assert.equal((await checklistFocus())?.row, name, `keyboard reaches ${name}`)
    await page.keyboard.press(' ')
  }

  async function expectChecklistAfterSwap(label, { rail, row, checked, surface }) {
    await page.waitForFunction(
      (expected) =>
        Array.from(document.querySelectorAll('[data-app-rail-item]'), (element) =>
          element.getAttribute('data-app-rail-item')
        ).join(',') === expected,
      rail
    )
    await paint(page)
    await paint(page)
    const focus = await checklistFocus()
    const watch = await stopWatch()
    results.push(
      `${label}: rail ${await railItems()}; checklist focus ${JSON.stringify(focus)}; frames sampled ${watch.frames}, without a checklist ${watch.withoutChecklist}`
    )
    assert.deepEqual(
      focus && {
        row: focus.row,
        checked: focus.checked,
        surface: focus.surface
      },
      { row, checked, surface },
      `${label}: the checklist stays open with focus on ${row}`
    )
    assert.equal(watch.withoutChecklist, 0, `${label}: no frame without the checklist`)
  }

  // Each flow passes or fails on its own, so a comparator run shows every flow's outcome.
  const failures = []
  async function flow(label, run) {
    try {
      await run()
      results.push(`PASS ${label}`)
    } catch (error) {
      results.push(
        `FAIL ${label}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
      )
      failures.push(label)
    }
  }
  try {
    await runChecks()
  } finally {
    console.log(results.join('\n'))
  }
  assert.deepEqual(failures, [], `${failures.length} flow(s) failed`)
  const after = await served(SOURCES)
  assert.deepEqual(after.lines, before.lines, 'the served sources did not change during the run')
  console.log(`screenshots in ${path.relative(process.cwd(), out)}`)

  async function runChecks() {
    const TALL = 'workspaces,tasks,customize,account'
    const FOLDED_AUTOMATIONS = 'workspaces,tasks,more,account'
    const TALL_AUTOMATIONS = 'workspaces,automations,customize,account'
    const FOLDED_ARTIFACTS = 'workspaces,automations,more,account'
    const ROOT = 'dropdown-menu-content'
    const SUB = 'dropdown-menu-sub-content'

    if (!only || only === 'c1-01') {
      for (const theme of ['light', 'dark']) {
        for (const input of ['mouse', 'keyboard']) {
          const label = `RC-C1-01 ${theme} ${input}`
          await flow(label, async () => {
            await renderFixture(page, url, 'fullRail', theme, {
              width: 800,
              height: 600
            })
            assert.equal(
              await railItems(),
              TALL,
              `${label}: starts with "…" on a full four-slot rail`
            )
            const trigger = page.locator('[data-app-rail-item="customize"]')
            if (input === 'mouse') {
              const box = await trigger.boundingBox()
              assert.ok(box)
              await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
            } else {
              await trigger.focus()
              await page.keyboard.press('Enter')
            }
            await page
              .getByRole('menuitemcheckbox', {
                name: 'Automations',
                exact: true
              })
              .waitFor()
            await paint(page)
            const act = (name) => (input === 'mouse' ? clickRowAlongPath(name) : pressSpaceOn(name))

            // Tall → fold: Automations doesn't fit, "…" becomes More, the checklist is now More > Customize.
            await watchFrames()
            await act('Automations')
            await expectChecklistAfterSwap(`${label} tall→fold (Automations on)`, {
              rail: FOLDED_AUTOMATIONS,
              row: 'Automations',
              checked: 'true',
              surface: SUB
            })
            await page.screenshot({
              path: path.join(out, `c1-01-${theme}-${input}-1-folded.png`)
            })

            if (input === 'keyboard') {
              await page.keyboard.press('ArrowDown')
              const artifacts = page.getByRole('menuitemcheckbox', {
                name: 'Artifacts',
                exact: true
              })
              await artifacts.and(page.locator(':focus')).waitFor()
              await page.evaluate(async () => {
                const { useAppStore } = await import('/src/store/index.ts')
                useAppStore.setState({ activeView: 'settings' })
              })
              await page.locator('[data-app-rail-item="account"][aria-current="page"]').waitFor()
              assert.ok(
                await artifacts.evaluate((node) => node === document.activeElement),
                `${label}: a rail render leaves keyboard focus on Artifacts`
              )
              results.push(`${label}: a rail render leaves keyboard focus on Artifacts`)
            }

            if (input === 'mouse') {
              // The pointer that clicked the row now rests over More's own rows; crossing More's row for the folded
              // page must not close the checklist before the pointer reaches it.
              const sibling = await page
                .locator('[data-slot="dropdown-menu-content"] [role=menuitem]', {
                  hasText: 'Automations'
                })
                .boundingBox()
              assert.ok(sibling, `${label}: More shows its row for the folded page`)
              await page.mouse.move(sibling.x + sibling.width / 2, sibling.y + sibling.height / 2, {
                steps: 6
              })
              await page.waitForTimeout(300)
              await paint(page)
              const stillOpen = await page.locator('[role=menuitemcheckbox]').count()
              results.push(
                `${label} hover More's Automations row after the fold: ${stillOpen} checklist rows`
              )
              assert.equal(
                stillOpen,
                5,
                `${label}: hovering a More row keeps the reopened checklist`
              )
            }

            // A second, different row from the reopened checklist. Fold → tall: Tasks leaves, More becomes "…".
            await watchFrames()
            await act('Tasks')
            await expectChecklistAfterSwap(`${label} fold→tall (Tasks off)`, {
              rail: TALL_AUTOMATIONS,
              row: 'Tasks',
              checked: 'false',
              surface: ROOT
            })
            await page.screenshot({
              path: path.join(out, `c1-01-${theme}-${input}-2-tall.png`)
            })

            // And a third, still without reopening: tall → fold again.
            await watchFrames()
            await act('Artifacts')
            await expectChecklistAfterSwap(`${label} tall→fold (Artifacts on)`, {
              rail: FOLDED_ARTIFACTS,
              row: 'Artifacts',
              checked: 'true',
              surface: SUB
            })
            await page.screenshot({
              path: path.join(out, `c1-01-${theme}-${input}-3-folded.png`)
            })
            if (input === 'keyboard') {
              const sibling = page
                .locator('[data-slot="dropdown-menu-content"]')
                .getByRole('menuitem', { name: 'Artifacts', exact: true })
              const box = await sibling.boundingBox()
              assert.ok(box, `${label}: More shows its Artifacts row`)
              await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
              await page.locator('[data-slot="dropdown-menu-sub-content"]').waitFor({
                state: 'hidden',
                timeout: 3000
              })
              assert.equal(await sibling.evaluate((node) => node === document.activeElement), true)
              results.push(
                `${label}: pointer entering the More row takes focus and closes Customize`
              )
            }
          })
        }
      }
    }

    if (!only || only === 'carry') {
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
        await page.locator('[data-app-rail-item="more"]').waitFor()
        await paint(page)
        assert.equal(
          await page.getByRole('menuitemcheckbox').count(),
          0,
          'the swapped menu stays closed'
        )
      }
      await flow('carry: toggle in place, navigate to Artifacts, then resize', async () => {
        await setup(true)
        const rootMenu = page.locator('[data-slot="dropdown-menu-content"]')
        // Measure the positioned wrapper. The menu inside it is still running its opening transform.
        const menuTop = () =>
          rootMenu.evaluate(
            (menu) =>
              menu.closest('[data-radix-popper-content-wrapper]').getBoundingClientRect().top
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
          predicate: (message) =>
            message.text().includes('fixture intentionally rejected the write')
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
        await page.evaluate(() => {
          const original = window.api.settings.set
          window.api.settings.set = (updates) =>
            new Promise((resolve) => {
              window.__landChecklistWrite = async () => resolve(await original(updates))
            })
        })
        await pressSpaceOn('Automations')
        await page.waitForFunction(() => typeof window.__landChecklistWrite === 'function')
        await page.keyboard.press('Escape')
        await page.locator('[role="menu"]').waitFor({ state: 'hidden' })
        await page.evaluate(() => window.__landChecklistWrite())
        await waitForClosedMore()
      })
    }

    if (!only || only === 'c1-02') {
      for (const variant of ['rail focus', 'outside input']) {
        const label = `RC-C1-02 ${variant}`
        await flow(label, async () => {
          await renderFixture(page, url, 'fullRail', 'light', {
            width: 800,
            height: 600
          })
          assert.equal(
            await railItems(),
            TALL,
            `${label}: a full four-slot rail with only Tasks shown`
          )
          assert.equal(
            await page.getAttribute('[data-app-rail-item="workspaces"]', 'aria-current'),
            'page',
            `${label}: Workspaces is active`
          )
          await page.locator('[data-app-rail-item="customize"]').focus()
          // Hold every animation frame from here so the recovery frame can't run until released; record its fate.
          await page.evaluate(() => {
            const realRequest = window.requestAnimationFrame.bind(window)
            const realCancel = window.cancelAnimationFrame.bind(window)
            const hold = {
              held: new Map(),
              recovery: [],
              canceled: [],
              ran: [],
              phase: 'idle',
              nextId: 1_000_000
            }
            window.__frameHold = hold
            window.requestAnimationFrame = (callback) => {
              const id = hold.nextId++
              hold.held.set(id, callback)
              // The rail's recovery frame is the one that reads the rail's rendered items.
              if (String(callback).includes('renderedItemsRef')) {
                hold.recovery.push({ id, phase: hold.phase })
              }
              return id
            }
            window.cancelAnimationFrame = (id) => {
              if (hold.held.delete(id)) {
                hold.canceled.push(id)
              } else {
                realCancel(id)
              }
            }
            window.__releaseFrames = () => {
              window.requestAnimationFrame = realRequest
              window.cancelAnimationFrame = realCancel
              for (const [id, callback] of hold.held) {
                hold.held.delete(id)
                hold.ran.push(id)
                callback(performance.now())
              }
            }
          })
          const commit = (phase, updates) =>
            page.evaluate(
              async ({ phase, updates }) => {
                window.__frameHold.phase = phase
                const { useAppStore } = await import('/src/store/index.ts')
                await useAppStore.getState().updateSettings(updates)
              },
              { phase, updates }
            )
          const holdState = () =>
            page.evaluate(() => {
              const hold = window.__frameHold
              return {
                recovery: hold.recovery,
                canceled: hold.canceled,
                ran: hold.ran
              }
            })
          const flags = () =>
            page.evaluate(async () => {
              const { useAppStore } = await import('/src/store/index.ts')
              const settings = useAppStore.getState().settings
              return {
                automations: settings?.showAutomationsButton,
                artifacts: settings?.showArtifactsButton
              }
            })

          // Commit 1: Automations folds the rail; "…" (and its focus) leaves, More takes the slot.
          await commit('automations', { showAutomationsButton: true })
          await page.waitForFunction(
            () => document.querySelector('[data-app-rail-item="more"]') !== null,
            null,
            { polling: 50 }
          )
          await page.evaluate(() => {
            window.__moreNode = document.querySelector('[data-app-rail-item="more"]')
          })
          const afterFirst = await holdState()
          const first = afterFirst.recovery.find((frame) => frame.phase === 'automations')
          assert.ok(
            first,
            `${label}: the fold scheduled a recovery frame (${JSON.stringify(afterFirst)})`
          )
          const focusBetween = await page.evaluate(() =>
            document.activeElement === document.body
              ? 'body'
              : document.activeElement?.outerHTML.slice(0, 60)
          )
          assert.equal(focusBetween, 'body', `${label}: focus left with "…"`)

          if (variant === 'outside input') {
            await page.evaluate(() => {
              const input = document.createElement('input')
              input.setAttribute('aria-label', 'outside probe')
              document.querySelector('.w-\\[220px\\]')?.append(input)
              window.__outsideInput = input
              input.focus()
            })
          }

          // Commit 2, before the first recovery frame runs: Artifacts folds into the same More.
          await commit('artifacts', { showArtifactsButton: true })
          await page.waitForFunction((id) => window.__frameHold.canceled.includes(id), first.id, {
            polling: 50
          })
          const witness = await page.evaluate(() => ({
            sameMore: document.querySelector('[data-app-rail-item="more"]') === window.__moreNode,
            rail: Array.from(document.querySelectorAll('[data-app-rail-item]'), (element) =>
              element.getAttribute('data-app-rail-item')
            ).join(',')
          }))
          const bothFlags = await flags()
          const afterSecond = await holdState()
          results.push(
            `${label}: first recovery frame ${first.id}; after commit 2 ${JSON.stringify({ ...witness, flags: bothFlags, ...afterSecond })}`
          )
          assert.ok(witness.sameMore, `${label}: both commits render the same More node`)
          assert.deepEqual(
            bothFlags,
            { automations: true, artifacts: true },
            `${label}: both flags on`
          )
          assert.ok(
            afterSecond.canceled.includes(first.id),
            `${label}: the first frame was canceled`
          )
          assert.ok(!afterSecond.ran.includes(first.id), `${label}: the first frame never ran`)

          await page.evaluate(() => window.__releaseFrames())
          await paint(page)
          await paint(page)
          const owner = await page.evaluate(() => {
            const active = document.activeElement
            return {
              moreOwnsFocus: active === window.__moreNode,
              inputKeepsFocus: active === window.__outsideInput && active.isConnected,
              active:
                active === document.body
                  ? 'body'
                  : (active?.getAttribute('data-app-rail-item') ?? active?.outerHTML.slice(0, 60))
            }
          })
          const final = await holdState()
          results.push(
            `${label}: after release focus on ${owner.active}; first frame ran: ${final.ran.includes(first.id)}`
          )
          assert.ok(!final.ran.includes(first.id), `${label}: the canceled frame stays canceled`)
          if (variant === 'rail focus') {
            assert.ok(owner.moreOwnsFocus, `${label}: the same More node owns focus at release`)
          } else {
            assert.ok(owner.inputKeepsFocus, `${label}: the outside input keeps focus at release`)
          }
        })
      }
    }
  }
})
