/**
 * E2E tests for tab management: creating, switching, reordering, and closing tabs.
 *
 * User Prompt:
 * - New tab works
 * - dragging tabs around to reorder them
 * - closing tabs works
 */

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  getActiveWorktreeId,
  getActiveTabId,
  getActiveTabType,
  getWorktreeTabs,
  getTabBarOrder,
  ensureTerminalVisible,
} from './helpers/store'

test.describe('Tabs', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await getActiveWorktreeId(orcaPage)
    expect(worktreeId).not.toBeNull()
    await ensureTerminalVisible(orcaPage)
  })

  test.afterEach(async ({ orcaPage }) => {
    // Clean up: close extra tabs back to 1 terminal tab.
    // Closing is done via Cmd+W which closes the active terminal pane/tab.
    const worktreeId = await getActiveWorktreeId(orcaPage)
    if (!worktreeId) return
    let tabs = await getWorktreeTabs(orcaPage, worktreeId)
    while (tabs.length > 1) {
      // Switch to the last tab and close it
      await orcaPage.keyboard.press('Meta+Shift+BracketRight')
      await orcaPage.keyboard.press('Meta+w')
      await expect
        .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 3_000 })
        .toBeLessThan(tabs.length)
        .catch(() => { /* cleanup best-effort */ })
      tabs = await getWorktreeTabs(orcaPage, worktreeId)
    }
  })

  /**
   * User Prompt:
   * - New tab works
   */
  test('clicking "+" then "New Terminal" creates a new terminal tab', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const tabsBefore = await getWorktreeTabs(orcaPage, worktreeId)

    // Click the "+" button in the tab bar
    const plusButton = orcaPage.getByRole('button', { name: 'New tab' })
    await plusButton.click()

    // Wait for the dropdown menu to appear and click "New Terminal"
    const menuItem = orcaPage.getByText('New Terminal', { exact: false }).first()
    await expect(menuItem).toBeVisible({ timeout: 3_000 })
    await menuItem.click()

    // Wait for the new tab to be created in the store
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBe(tabsBefore.length + 1)
  })

  /**
   * User Prompt:
   * - New tab works
   */
  test('Cmd+T creates a new terminal tab', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    const tabsBefore = await getWorktreeTabs(orcaPage, worktreeId)

    await orcaPage.keyboard.press('Meta+t')

    // Wait for the tab to appear in the store
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBe(tabsBefore.length + 1)

    // The new tab should be active
    const activeTabId = await getActiveTabId(orcaPage)
    expect(activeTabId).not.toBeNull()
    const activeType = await getActiveTabType(orcaPage)
    expect(activeType).toBe('terminal')
  })

  /**
   * User Prompt:
   * - New tab works
   */
  test('Cmd+Shift+] and Cmd+Shift+[ switch between tabs', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Ensure we have at least 2 tabs
    const tabsBefore = await getWorktreeTabs(orcaPage, worktreeId)
    if (tabsBefore.length < 2) {
      await orcaPage.keyboard.press('Meta+t')
      await expect
        .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
        .toBeGreaterThanOrEqual(2)
    }

    const firstTabId = await getActiveTabId(orcaPage)

    // Switch to next tab
    await orcaPage.keyboard.press('Meta+Shift+BracketRight')
    await expect
      .poll(async () => getActiveTabId(orcaPage), { timeout: 3_000 })
      .not.toBe(firstTabId)

    const secondTabId = await getActiveTabId(orcaPage)
    expect(secondTabId).not.toBe(firstTabId)

    // Switch back to previous tab
    await orcaPage.keyboard.press('Meta+Shift+BracketLeft')
    await expect
      .poll(async () => getActiveTabId(orcaPage), { timeout: 3_000 })
      .toBe(firstTabId)
  })

  /**
   * User Prompt:
   * - dragging tabs around to reorder them
   */
  test('dragging a tab to a new position reorders it', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Ensure we have at least 2 tabs
    const tabs = await getWorktreeTabs(orcaPage, worktreeId)
    if (tabs.length < 2) {
      await orcaPage.keyboard.press('Meta+t')
      await expect
        .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
        .toBeGreaterThanOrEqual(2)
    }

    const orderBefore = await getTabBarOrder(orcaPage, worktreeId)

    // Find tab elements in the tab strip
    // Why: @dnd-kit/sortable spreads aria-roledescription="sortable" on each
    // draggable element via useSortable(). All tab types (terminal, editor,
    // browser) use useSortable so they all carry this attribute.
    const tabElements = orcaPage.locator('.terminal-tab-strip [aria-roledescription="sortable"]')
    const tabCount = await tabElements.count()
    expect(tabCount).toBeGreaterThanOrEqual(2)

    const firstTab = tabElements.nth(0)
    const secondTab = tabElements.nth(1)
    const firstBox = await firstTab.boundingBox()
    const secondBox = await secondTab.boundingBox()
    expect(firstBox).not.toBeNull()
    expect(secondBox).not.toBeNull()

    // Drag first tab to the position of the second tab
    // Why: @dnd-kit PointerSensor has activation distance of 5px
    await orcaPage.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(
      secondBox!.x + secondBox!.width / 2,
      secondBox!.y + secondBox!.height / 2,
      { steps: 15 }
    )
    await orcaPage.mouse.up()

    // Verify the order changed
    await expect
      .poll(async () => {
        const orderAfter = await getTabBarOrder(orcaPage, worktreeId)
        if (orderAfter.length < 2) return false
        return JSON.stringify(orderAfter) !== JSON.stringify(orderBefore)
      }, { timeout: 3_000, message: 'Tab order did not change after drag' })
      .toBe(true)
  })

  /**
   * User Prompt:
   * - closing tabs works
   */
  test('closing a tab removes it from the tab bar', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Create a second tab so we can close one without deactivating the worktree
    await orcaPage.keyboard.press('Meta+t')
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThanOrEqual(2)

    const tabsBefore = await getWorktreeTabs(orcaPage, worktreeId)

    // Close the active tab with Cmd+W
    await orcaPage.keyboard.press('Meta+w')

    // Wait for tab count to decrease
    await expect
      .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBe(tabsBefore.length - 1)
  })

  /**
   * User Prompt:
   * - closing tabs works
   */
  test('closing the active tab activates a neighbor tab', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Ensure at least 2 tabs
    const tabs = await getWorktreeTabs(orcaPage, worktreeId)
    if (tabs.length < 2) {
      await orcaPage.keyboard.press('Meta+t')
      await expect
        .poll(async () => (await getWorktreeTabs(orcaPage, worktreeId)).length, { timeout: 5_000 })
        .toBeGreaterThanOrEqual(2)
    }

    const activeTabBefore = await getActiveTabId(orcaPage)
    expect(activeTabBefore).not.toBeNull()

    // Close the active tab
    await orcaPage.keyboard.press('Meta+w')

    // A neighbor tab should become active
    await expect
      .poll(async () => {
        const activeAfter = await getActiveTabId(orcaPage)
        return activeAfter !== null && activeAfter !== activeTabBefore
      }, { timeout: 5_000 })
      .toBe(true)
  })
})
