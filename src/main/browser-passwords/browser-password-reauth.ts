import { systemPreferences } from 'electron'
import { browserPasswordSettings } from './browser-password-vault-access'
import type { BrowserPasswordReauthMethod } from '../../shared/browser-passwords-types'

// Chrome and Firefox both keep a successful check for five minutes.
const REAUTH_VALIDITY_MS = 5 * 60 * 1000

let lastReauthAt: number | null = null

export function browserPasswordReauthMethod(): BrowserPasswordReauthMethod {
  return process.platform === 'darwin' && systemPreferences.canPromptTouchID() ? 'touch-id' : 'none'
}

/**
 * Asks the OS to confirm the user before a password leaves the vault for display or the clipboard.
 * Why this is a confirmation step, not encryption: Touch ID here only gates Orca's own UI (Electron's
 * promptTouchID releases no key). Windows Hello and Linux have no Electron API, so they pass; the
 * Settings page says so.
 */
export async function confirmBrowserPasswordOwner(
  reason: string,
  options: { always?: boolean } = {}
): Promise<boolean> {
  const now = Date.now()
  if (!options.always && lastReauthAt !== null && now - lastReauthAt < REAUTH_VALIDITY_MS) {
    return true
  }
  if (browserPasswordReauthMethod() === 'none') {
    return true
  }
  try {
    await systemPreferences.promptTouchID(reason)
  } catch {
    return false
  }
  lastReauthAt = Date.now()
  return true
}

/** Test seam: forget the last successful check. */
export function resetBrowserPasswordReauthForTests(): void {
  lastReauthAt = null
}

export async function confirmBrowserPasswordFill(): Promise<boolean> {
  return (
    !browserPasswordSettings().fillRequiresReauth ||
    confirmBrowserPasswordOwner('fill a saved password', { always: true })
  )
}
