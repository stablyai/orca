import type { WebContents } from 'electron'

// Why: Orca's guest shortcut and grab handlers act on keys the page receives, and an unhandled key
// can reach the app menu. Keys an agent injects must do neither (#20595), whichever path sends them.
const injectionDepth = new WeakMap<WebContents, number>()

export function isAgentInjectingInput(webContents: WebContents): boolean {
  return (injectionDepth.get(webContents) ?? 0) > 0
}

/** Marks input sent during `run` as the agent's: Orca shortcuts and app menu items ignore it. */
export async function withAgentInputInjection<T>(
  webContents: WebContents,
  run: () => Promise<T>
): Promise<T> {
  const depth = injectionDepth.get(webContents) ?? 0
  injectionDepth.set(webContents, depth + 1)
  if (depth === 0) {
    webContents.setIgnoreMenuShortcuts(true)
  }
  try {
    return await run()
  } finally {
    const remaining = (injectionDepth.get(webContents) ?? 1) - 1
    if (remaining > 0) {
      injectionDepth.set(webContents, remaining)
    } else {
      injectionDepth.delete(webContents)
      if (!webContents.isDestroyed()) {
        webContents.setIgnoreMenuShortcuts(false)
      }
    }
  }
}
