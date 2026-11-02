import type { WebContents } from 'electron'
import { assertRemoteCliPageAccess } from './remote-cli-page-admission'

// Agent keys must bypass Orca shortcuts, grab handlers, and app menus (#20595).
type InjectionTarget = Pick<WebContents, 'id' | 'isDestroyed' | 'setIgnoreMenuShortcuts'>

const injectionDepth = new WeakMap<InjectionTarget, number>()

export function isAgentInjectingInput(webContents: InjectionTarget): boolean {
  return (injectionDepth.get(webContents) ?? 0) > 0
}

export async function withAgentInputInjection<T>(
  webContents: InjectionTarget,
  run: () => Promise<T>
): Promise<T> {
  assertRemoteCliPageAccess(webContents.id)
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
