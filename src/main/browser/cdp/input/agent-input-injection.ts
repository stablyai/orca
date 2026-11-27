import type { WebContents } from 'electron'
import { assertRemoteCliPageAccess } from '../../routing/input-ownership/remote-cli-page-admission'

// Agent keys must bypass Orca shortcuts, grab handlers, and app menus (#20595).
type InjectionTarget = Pick<WebContents, 'id' | 'isDestroyed' | 'setIgnoreMenuShortcuts'>

const RECENT_INJECTION_ECHO_MS = 300
const injectionDepth = new WeakMap<InjectionTarget, number>()
const lastInjectionEndedAt = new WeakMap<InjectionTarget, number>()

export function isAgentInjectingInput(webContents: InjectionTarget): boolean {
  return (injectionDepth.get(webContents) ?? 0) > 0
}

/** True briefly after injection finishes so delayed cross-origin iframe echoes stay attributable to paired viewers. */
export function wasRecentlyInjectingInput(webContents: InjectionTarget): boolean {
  const endedAt = lastInjectionEndedAt.get(webContents)
  return endedAt !== undefined && Date.now() - endedAt <= RECENT_INJECTION_ECHO_MS
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
      lastInjectionEndedAt.set(webContents, Date.now())
      if (!webContents.isDestroyed()) {
        webContents.setIgnoreMenuShortcuts(false)
      }
    }
  }
}
