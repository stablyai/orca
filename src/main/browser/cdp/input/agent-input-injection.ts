import type { WebContents } from 'electron'
import { assertRemoteCliPageAccess } from '../../routing/input-ownership/remote-cli-page-admission'

// Agent keys must bypass Orca shortcuts, grab handlers, and app menus (#20595).
type InjectionTarget = Pick<WebContents, 'id' | 'isDestroyed' | 'setIgnoreMenuShortcuts'>

const suspensions = new WeakMap<InjectionTarget, (suspended: boolean) => Promise<void>>()

export function registerAgentInputSuspension(
  target: InjectionTarget,
  suspend: (suspended: boolean) => Promise<void>
): () => void {
  suspensions.set(target, suspend)
  return () => {
    if (suspensions.get(target) === suspend) {
      suspensions.delete(target)
    }
  }
}

const suspensionGates = new WeakMap<InjectionTarget, Promise<void>>()
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
    if (depth === 0) {
      suspensionGates.set(webContents, suspensions.get(webContents)?.(true) ?? Promise.resolve())
    }
    await suspensionGates.get(webContents)
    return await run()
  } finally {
    const remaining = (injectionDepth.get(webContents) ?? 1) - 1
    if (remaining > 0) {
      injectionDepth.set(webContents, remaining)
    } else {
      injectionDepth.delete(webContents)
      suspensionGates.delete(webContents)
      try {
        await suspensions.get(webContents)?.(false)
      } finally {
        if (!webContents.isDestroyed() && !isAgentInjectingInput(webContents)) {
          webContents.setIgnoreMenuShortcuts(false)
        }
      }
    }
  }
}
