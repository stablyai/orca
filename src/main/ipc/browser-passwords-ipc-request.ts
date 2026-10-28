import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import type { BrowserPasswordStore } from '../browser-passwords/browser-password-store'
import { browserPasswordVaultFor } from '../browser-passwords/browser-password-vault-access'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export type BrowserPasswordsVaultRequest = {
  args: Record<string, unknown>
  browserProfileId: string
  vault: BrowserPasswordStore
}

export function readBrowserPasswordsArgs(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? { ...value } : {}
}

/** Only Orca's own renderer may reach a vault, and only one of a known browser profile. */
export function readBrowserPasswordsVaultRequest(
  event: IpcMainInvokeEvent,
  raw: unknown
): BrowserPasswordsVaultRequest | null {
  const args = readBrowserPasswordsArgs(raw)
  const browserProfileId = args.browserProfileId
  if (
    !isTrustedBrowserRenderer(event.sender) ||
    typeof browserProfileId !== 'string' ||
    !browserSessionRegistry.getProfile(browserProfileId)
  ) {
    return null
  }
  return { args, browserProfileId, vault: browserPasswordVaultFor(browserProfileId) }
}

export function handleBrowserPasswordsChannel<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, raw: unknown) => T
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, handler)
}
