import { app } from 'electron'
import { join } from 'node:path'
import { BrowserPasswordStore } from './browser-password-store'
import type { BrowserPasswordStoreResult } from './browser-password-vault-file'

const BROWSER_PASSWORD_VAULT_DIRECTORY = 'browser-passwords'

// Why keyed by file path: the same browser profile id ('default') exists in every Orca profile.
const vaults = new Map<string, BrowserPasswordStore>()
let profileDirectory: string | null = null

/** Points vaults at the active Orca profile, beside its browser-session metadata. */
export function configureBrowserPasswordVaults(directory: string): void {
  profileDirectory = directory
}

function vaultFilePath(browserProfileId: string): string {
  return join(
    profileDirectory ?? app.getPath('userData'),
    BROWSER_PASSWORD_VAULT_DIRECTORY,
    `${encodeURIComponent(browserProfileId)}.json`
  )
}

/** One vault per browser profile. */
export function getBrowserPasswordVault(browserProfileId: string): BrowserPasswordStore {
  const filePath = vaultFilePath(browserProfileId)
  let vault = vaults.get(filePath)
  if (!vault) {
    vault = new BrowserPasswordStore(filePath)
    vaults.set(filePath, vault)
  }
  return vault
}

/** Deletes a profile's saved logins; the cached store goes only once the file is really gone. */
export function deleteBrowserPasswordVault(
  target: string | BrowserPasswordStore
): BrowserPasswordStoreResult<true> {
  const vault = typeof target === 'string' ? getBrowserPasswordVault(target) : target
  const filePath = [...vaults].find(([, stored]) => stored === vault)?.[0]
  if (!filePath) {
    return { ok: false, reason: 'unavailable', message: 'This password vault was deleted.' }
  }
  const deleted = vault.deleteFile()
  if (deleted.ok) {
    vaults.delete(filePath)
  }
  return deleted
}

/** For a deleted browser profile: the deletion already happened, so a failure can only be reported. */
export function forgetBrowserPasswordVault(browserProfileId: string): void {
  let deleted: BrowserPasswordStoreResult<true>
  try {
    deleted = deleteBrowserPasswordVault(browserProfileId)
  } catch (error) {
    deleted = { ok: false, reason: 'unavailable', message: String(error) }
  }
  if (!deleted.ok) {
    console.warn('[browser-passwords] Could not delete saved logins for profile', browserProfileId)
  }
}
