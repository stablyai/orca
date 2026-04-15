/**
 * Terminal interaction helpers for Orca E2E tests.
 *
 * Why: xterm.js uses a canvas renderer that does NOT respond to CDP key events
 * or ClipboardEvent paste simulation. Terminal input must go through the PTY
 * write IPC bridge: window.api.pty.write(ptyId, data).
 *
 * Terminal content is read via the SerializeAddon (loaded by the PaneManager)
 * through window.__paneManagers, which is exposed when VITE_EXPOSE_STORE=true.
 */

import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

/**
 * Read terminal content from the active pane's serialize addon.
 *
 * Why: xterm.js v6 doesn't render a .xterm-accessibility element unless the
 * @xterm/addon-accessibility addon is loaded (it isn't). Instead, we read the
 * buffer through the SerializeAddon that the PaneManager already loads for
 * every terminal pane. window.__paneManagers is exposed via VITE_EXPOSE_STORE.
 */
export async function getTerminalContent(page: Page, charLimit = 4000): Promise<string> {
  return page.evaluate((charLimit) => {
    const store = (window as any).__store
    const paneManagers: Map<string, any> | undefined = (window as any).__paneManagers
    if (!store || !paneManagers) return ''

    const activeTabId = store.getState().activeTabId
    if (!activeTabId) return ''

    const manager = paneManagers.get(activeTabId)
    if (!manager) return ''

    const activePane = manager.getActivePane?.()
    if (!activePane) {
      // Fallback: try all panes
      const panes = manager.getPanes?.() ?? []
      if (panes.length === 0) return ''
      const text = panes[0].serializeAddon?.serialize?.() ?? ''
      return text.slice(-charLimit)
    }

    const text = activePane.serializeAddon?.serialize?.() ?? ''
    return text.slice(-charLimit)
  }, charLimit)
}

/**
 * Discover the PTY ID of the currently visible/active terminal pane.
 *
 * Why: PTY IDs are opaque sequential integers. The mapping from visible
 * terminal -> PTY ID isn't exposed in the DOM. We get the active tab's
 * PTY IDs from the Zustand store, write a unique marker to each candidate,
 * then read back from the terminal buffer via SerializeAddon.
 */
export async function discoverActivePtyId(page: Page, maxId = 10): Promise<string> {
  const marker = `__PTY_PROBE_${Date.now()}__`

  // Get candidate PTY IDs from the store
  const candidateIds: string[] = await page.evaluate(() => {
    const store = (window as any).__store
    if (!store) return []
    const state = store.getState()
    const activeTabId = state.activeTabId
    if (!activeTabId) return []
    return state.ptyIdsByTabId[activeTabId] ?? []
  })

  const idsToProbe =
    candidateIds.length > 0
      ? candidateIds
      : Array.from({ length: maxId }, (_, i) => String(i + 1))

  // Write the marker to each candidate PTY
  await page.evaluate(
    ({ marker, idsToProbe }) => {
      for (const id of idsToProbe) {
        ;(window as any).api.pty.write(String(id), `\x03\x15echo ${marker}_${id}\r`)
      }
    },
    { marker, idsToProbe }
  )

  // Wait for the marker to appear in the terminal buffer via SerializeAddon
  let foundPtyId: string | null = null
  await expect
    .poll(
      async () => {
        const content = await getTerminalContent(page)
        const markerRe = new RegExp(`${marker}_(\\d+)`, 'g')
        const matches = [...content.matchAll(markerRe)]
        if (matches.length > 0) {
          foundPtyId = matches[matches.length - 1][1]
          return true
        }
        return false
      },
      { timeout: 10_000, message: 'PTY marker did not appear in terminal buffer' }
    )
    .toBe(true)

  if (!foundPtyId) {
    throw new Error('discoverActivePtyId: no marker found in terminal buffer')
  }

  return foundPtyId
}

/** Send raw text to a specific PTY. Use \r for Enter, \x03 for Ctrl+C. */
export async function sendToTerminal(page: Page, ptyId: string, text: string): Promise<void> {
  await page.evaluate(
    ({ ptyId, text }) => {
      ;(window as any).api.pty.write(ptyId, text)
    },
    { ptyId, text }
  )
}

/** Send a shell command and press Enter. */
export async function execInTerminal(page: Page, ptyId: string, command: string): Promise<void> {
  await sendToTerminal(page, ptyId, `${command}\r`)
}

/** Count the number of visible xterm panes (split panes). */
export async function countVisibleTerminalPanes(page: Page): Promise<number> {
  return page.evaluate(() => {
    const xterms = document.querySelectorAll('.xterm')
    return Array.from(xterms).filter((x) => (x as HTMLElement).offsetParent !== null).length
  })
}

/**
 * Wait until terminal output contains the expected text.
 * Uses expect.poll for proper Playwright waiting behavior.
 */
export async function waitForTerminalOutput(
  page: Page,
  expected: string,
  timeoutMs = 10_000
): Promise<void> {
  await expect
    .poll(async () => (await getTerminalContent(page)).includes(expected), {
      timeout: timeoutMs,
      message: `Terminal did not contain "${expected}"`,
    })
    .toBe(true)
}

/**
 * Wait until the visible terminal pane count reaches the expected value.
 * Uses expect.poll instead of arbitrary waitForTimeout.
 */
export async function waitForPaneCount(
  page: Page,
  expectedCount: number,
  timeoutMs = 10_000
): Promise<void> {
  await expect
    .poll(async () => countVisibleTerminalPanes(page), {
      timeout: timeoutMs,
      message: `Expected ${expectedCount} visible terminal panes`,
    })
    .toBe(expectedCount)
}
