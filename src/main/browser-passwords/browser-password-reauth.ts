import { systemPreferences } from 'electron'
import { runProcess } from '@orca/process-host'
import { browserPasswordSettings } from './browser-password-vault-access'
import type { BrowserPasswordReauthMethod } from '../../shared/browser-passwords-types'

// Chrome and Firefox both keep a successful check for five minutes.
const REAUTH_VALIDITY_MS = 5 * 60 * 1000

let lastReauthAt: number | null = null
let touchIdEnrolled: Promise<boolean> | null = null

// Why enrollment, not canPromptTouchID: lockout or a closed lid also make that false, and those must
// not count as a Mac without Touch ID.
function isTouchIdEnrolled(): Promise<boolean> {
  touchIdEnrolled ??= runProcess({ program: '/usr/bin/bioutil', args: ['-c'], timeoutMs: 5_000 })
    .then(
      (result) =>
        result.code === 0 && Number(/(\d+) biometric template/.exec(result.stdout)?.[1]) > 0
    )
    .catch(() => false)
  return touchIdEnrolled
}

export async function browserPasswordReauthMethod(): Promise<BrowserPasswordReauthMethod> {
  if (process.platform !== 'darwin') {
    return 'none'
  }
  if (systemPreferences.canPromptTouchID()) {
    return 'touch-id'
  }
  return (await isTouchIdEnrolled()) ? 'touch-id-unavailable' : 'none'
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
  const method = await browserPasswordReauthMethod()
  if (method !== 'touch-id') {
    return method === 'none'
  }
  try {
    await systemPreferences.promptTouchID(reason)
  } catch {
    return false
  }
  lastReauthAt = Date.now()
  return true
}

/** Test seam: forget the last successful check and the enrollment lookup. */
export function resetBrowserPasswordReauthForTests(): void {
  lastReauthAt = null
  touchIdEnrolled = null
}

export async function confirmBrowserPasswordFill(): Promise<boolean> {
  return (
    !browserPasswordSettings().fillRequiresReauth ||
    confirmBrowserPasswordOwner('fill a saved password', { always: true })
  )
}
