import type { WebContents } from 'electron'
import { setBrowserInputGuard, hasBrowserInputGuard } from './browser-input-guard'
import { assertRemoteCliPageAccess } from '../../routing/input-ownership/remote-cli-page-admission'

// Agent keys must bypass Orca shortcuts, grab handlers, and app menus (#20595).
type InjectionTarget = Pick<WebContents, 'id' | 'isDestroyed' | 'setIgnoreMenuShortcuts'> & {
  once?: {
    (event: 'dom-ready', listener: () => void): unknown
    (event: 'destroyed', listener: () => void): unknown
  }
  off?: {
    (event: 'dom-ready', listener: () => void): unknown
    (event: 'destroyed', listener: () => void): unknown
  }
}

const suspensions = new WeakMap<InjectionTarget, Set<(suspended: boolean) => Promise<void>>>()

async function setSuspended(target: InjectionTarget, suspended: boolean): Promise<void> {
  await setBrowserInputGuard(target, suspended)
  await Promise.all(Array.from(suspensions.get(target) ?? [], (update) => update(suspended)))
}
const unacknowledged = new WeakSet<InjectionTarget>()
const recoveryListeners = new WeakSet<InjectionTarget>()

function markUnacknowledged(target: InjectionTarget): void {
  unacknowledged.add(target)
  if (recoveryListeners.has(target) || !target.once) {
    return
  }
  recoveryListeners.add(target)
  const newDocument = (): void => {
    unacknowledged.delete(target)
    recoveryListeners.delete(target)
    target.off?.('dom-ready', newDocument)
    target.off?.('destroyed', newDocument)
  }
  target.once('dom-ready', newDocument)
  target.once('destroyed', newDocument)
}

async function suspendBeforeInput(target: InjectionTarget): Promise<void> {
  const suspend = suspensions.get(target)
  if (!suspend) {
    if (unacknowledged.has(target) && !hasBrowserInputGuard(target)) {
      throw new Error('Browser tool shortcuts have not acknowledged suspension')
    }
    await setBrowserInputGuard(target, true)
    unacknowledged.delete(target)
    return
  }
  try {
    await setSuspended(target, true)
    unacknowledged.delete(target)
  } catch (error) {
    markUnacknowledged(target)
    throw error
  }
}

export function registerAgentInputSuspension(
  target: InjectionTarget,
  suspend: (suspended: boolean) => Promise<void>
): () => void {
  const callbacks = suspensions.get(target) ?? new Set()
  callbacks.add(suspend)
  suspensions.set(target, callbacks)
  return () => {
    callbacks.delete(suspend)
    if (callbacks.size === 0 && suspensions.get(target) === callbacks) {
      suspensions.delete(target)
    }
  }
}

const suspensionGates = new WeakMap<InjectionTarget, Promise<void>>()
const injectionDepth = new WeakMap<InjectionTarget, number>()
const keyboardDepth = new WeakMap<InjectionTarget, number>()

export function isAgentInjectingInput(webContents: InjectionTarget): boolean {
  return (injectionDepth.get(webContents) ?? 0) > 0
}

export async function withAgentInputInjection<T>(
  webContents: InjectionTarget,
  run: () => Promise<T>,
  options: { keyboard?: boolean } = {}
): Promise<T> {
  assertRemoteCliPageAccess(webContents.id)
  const depth = injectionDepth.get(webContents) ?? 0
  const keyboard = options.keyboard !== false
  const keys = keyboardDepth.get(webContents) ?? 0
  injectionDepth.set(webContents, depth + 1)
  if (depth === 0) {
    webContents.setIgnoreMenuShortcuts(true)
  }
  if (keyboard) {
    keyboardDepth.set(webContents, keys + 1)
  }
  try {
    if (keyboard) {
      if (keys === 0) {
        suspensionGates.set(webContents, suspendBeforeInput(webContents))
      }
      await suspensionGates.get(webContents)
    }
    return await run()
  } finally {
    const remaining = (injectionDepth.get(webContents) ?? 1) - 1
    if (remaining > 0) {
      injectionDepth.set(webContents, remaining)
    } else {
      injectionDepth.delete(webContents)
    }
    try {
      if (keyboard) {
        const remainingKeys = (keyboardDepth.get(webContents) ?? 1) - 1
        if (remainingKeys > 0) {
          keyboardDepth.set(webContents, remainingKeys)
        } else {
          keyboardDepth.delete(webContents)
          suspensionGates.delete(webContents)
          // Recovery cannot replace a delivered result or its original error.
          await setSuspended(webContents, false).catch(() => markUnacknowledged(webContents))
        }
      }
    } finally {
      if (!webContents.isDestroyed() && !isAgentInjectingInput(webContents)) {
        webContents.setIgnoreMenuShortcuts(false)
      }
    }
  }
}

export function isAgentInjectingKeyboard(target: InjectionTarget): boolean {
  return (keyboardDepth.get(target) ?? 0) > 0
}

export async function recoverBrowserInputGuard(target: WebContents): Promise<boolean> {
  if (isAgentInjectingKeyboard(target)) {
    return true
  }
  try {
    await setBrowserInputGuard(target, false)
    unacknowledged.delete(target)
    return true
  } catch {
    markUnacknowledged(target)
    return false
  }
}
