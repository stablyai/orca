/**
 * Zustand store inspection helpers for Orca E2E tests.
 *
 * Why: In dev mode, Orca exposes `window.__store` (the Zustand useAppStore).
 * Reading store state gives tests reliable access to app state without
 * fragile DOM scraping.
 */

import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

/** Read a value from the Zustand store. Returns the raw JS value. */
export async function getStoreState<T = any>(page: Page, selector: string): Promise<T> {
  return page.evaluate((selector) => {
    const store = (window as any).__store
    if (!store) throw new Error('window.__store is not available — is the app in dev mode?')
    const state = store.getState()
    // Support dot-notation selectors like 'activeWorktreeId' or 'tabsByWorktree'
    return selector.split('.').reduce((obj: any, key: string) => obj?.[key], state)
  }, selector)
}

/** Get the active worktree ID. */
export async function getActiveWorktreeId(page: Page): Promise<string | null> {
  return getStoreState<string | null>(page, 'activeWorktreeId')
}

/** Get the active tab ID. */
export async function getActiveTabId(page: Page): Promise<string | null> {
  return getStoreState<string | null>(page, 'activeTabId')
}

/** Get the active tab type ('terminal' | 'editor' | 'browser'). */
export async function getActiveTabType(page: Page): Promise<string | null> {
  return getStoreState<string | null>(page, 'activeTabType')
}

/** Get all terminal tabs for a given worktree. */
export async function getWorktreeTabs(
  page: Page,
  worktreeId: string
): Promise<Array<{ id: string; title?: string }>> {
  return page.evaluate((worktreeId) => {
    const store = (window as any).__store
    if (!store) return []
    const state = store.getState()
    return (state.tabsByWorktree[worktreeId] ?? []).map((t: any) => ({
      id: t.id,
      title: t.customTitle || t.title,
    }))
  }, worktreeId)
}

/** Get the tab bar order for a worktree. */
export async function getTabBarOrder(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate((worktreeId) => {
    const store = (window as any).__store
    if (!store) return []
    const state = store.getState()
    return state.tabBarOrderByWorktree[worktreeId] ?? []
  }, worktreeId)
}

/** Get browser tabs for a given worktree. */
export async function getBrowserTabs(
  page: Page,
  worktreeId: string
): Promise<Array<{ id: string; url?: string; title?: string }>> {
  return page.evaluate((worktreeId) => {
    const store = (window as any).__store
    if (!store) return []
    const state = store.getState()
    return (state.browserTabsByWorktree[worktreeId] ?? []).map((t: any) => ({
      id: t.id,
      url: t.url,
      title: t.title,
    }))
  }, worktreeId)
}

/** Get open editor files for a given worktree. */
export async function getOpenFiles(
  page: Page,
  worktreeId: string
): Promise<Array<{ id: string; filePath: string; relativePath: string }>> {
  return page.evaluate((worktreeId) => {
    const store = (window as any).__store
    if (!store) return []
    const state = store.getState()
    return state.openFiles
      .filter((f: any) => f.worktreeId === worktreeId)
      .map((f: any) => ({
        id: f.id,
        filePath: f.filePath,
        relativePath: f.relativePath,
      }))
  }, worktreeId)
}

/** Wait until the workspace session is ready. Uses expect.poll for proper Playwright waiting. */
export async function waitForSessionReady(page: Page, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(async () => getStoreState<boolean>(page, 'workspaceSessionReady'), {
      timeout: timeoutMs,
      message: 'workspaceSessionReady did not become true',
    })
    .toBe(true)
}

/** Get all worktree IDs across all repos. */
export async function getAllWorktreeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const store = (window as any).__store
    if (!store) return []
    const state = store.getState()
    const allWorktrees = Object.values(state.worktreesByRepo).flat() as any[]
    return allWorktrees.map((wt: any) => wt.id)
  })
}

/** Switch to a different worktree via the store. Returns the new worktree ID or null. */
export async function switchToOtherWorktree(page: Page, currentWorktreeId: string): Promise<string | null> {
  return page.evaluate((currentId) => {
    const store = (window as any).__store
    if (!store) return null
    const state = store.getState()
    const allWorktrees = Object.values(state.worktreesByRepo).flat() as any[]
    const other = allWorktrees.find((wt: any) => wt.id !== currentId)
    if (!other) return null
    state.setActiveWorktree(other.id)
    return other.id
  }, currentWorktreeId)
}

/** Switch to a specific worktree via the store. */
export async function switchToWorktree(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = (window as any).__store
    if (!store) return
    store.getState().setActiveWorktree(id)
  }, worktreeId)
}

/**
 * Ensure the active tab is a terminal and at least one xterm pane is visible.
 *
 * Why: after worktree switching or browser tab tests, the first .xterm in
 * DOM order may belong to a hidden worktree. This helper switches to the
 * terminal tab type and polls for any visible xterm element, avoiding the
 * pitfall of `.locator('.xterm').first()` which picks by DOM order.
 */
export async function ensureTerminalVisible(page: Page, timeoutMs = 10_000): Promise<void> {
  await page.evaluate(() => {
    const store = (window as any).__store
    if (!store) return
    if (store.getState().activeTabType !== 'terminal') {
      store.getState().setActiveTabType('terminal')
    }
  })
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const xterms = document.querySelectorAll('.xterm')
          return Array.from(xterms).some(
            (x) => (x as HTMLElement).offsetParent !== null
          )
        }),
      { timeout: timeoutMs, message: 'No visible xterm pane found' }
    )
    .toBe(true)
}

/** Check if a worktree exists in the store. */
export async function worktreeExists(page: Page, name: string): Promise<boolean> {
  return page.evaluate((name) => {
    const store = (window as any).__store
    if (!store) return false
    const state = store.getState()
    const allWorktrees = Object.values(state.worktreesByRepo).flat() as any[]
    return allWorktrees.some(
      (wt) =>
        wt.displayName === name || wt.name === name || wt.path?.endsWith(`/${name}`)
    )
  }, name)
}
