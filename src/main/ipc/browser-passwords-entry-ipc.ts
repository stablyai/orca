import { clipboard } from 'electron'
import type {
  BrowserPasswordCopyResult,
  BrowserPasswordEntryDetailsResult,
  BrowserPasswordEntryEditResult
} from '../../shared/browser-passwords-types'
import { toBrowserPasswordOrigin } from '../browser-passwords/browser-password-origin'
import { confirmBrowserPasswordOwner } from '../browser-passwords/browser-password-reauth'
import type { BrowserPasswordStoreResult } from '../browser-passwords/browser-password-vault-file'
import { deleteBrowserPasswordVault } from '../browser-passwords/browser-password-vaults'
import {
  handleBrowserPasswordsChannel,
  readBrowserPasswordsVaultRequest
} from './browser-passwords-ipc-request'

// Chrome clears a copied password after two minutes.
const CLIPBOARD_CLEAR_MS = 120_000

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A site as people type it: a bare host gets https, then only its origin is kept. */
function siteOrigin(site: string): string | null {
  const trimmed = site.trim()
  return toBrowserPasswordOrigin(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
}

function editFailure(result: BrowserPasswordStoreResult<unknown>): BrowserPasswordEntryEditResult {
  if (result.ok) {
    return { ok: true }
  }
  if (result.reason === 'duplicate' || result.reason === 'invalid-password') {
    return { ok: false, reason: result.reason }
  }
  return { ok: false, reason: result.reason === 'invalid-origin' ? 'invalid-site' : 'unavailable' }
}

export function registerBrowserPasswordsEntryHandlers(): void {
  handleBrowserPasswordsChannel(
    'browserPasswords:getEntryDetails',
    async (event, raw): Promise<BrowserPasswordEntryDetailsResult> => {
      const request = readBrowserPasswordsVaultRequest(event, raw)
      const entryId = request ? text(request.args.entryId) : ''
      if (!request || !entryId) {
        return { ok: false, reason: 'unavailable' }
      }
      if (!(await confirmBrowserPasswordOwner('show a saved password'))) {
        return { ok: false, reason: 'auth-failed' }
      }
      const password = request.vault.getPassword(entryId)
      const note = request.vault.getNote(entryId)
      if (!password.ok) {
        return { ok: false, reason: password.reason === 'not-found' ? 'not-found' : 'unavailable' }
      }
      if (!note.ok) {
        return { ok: false, reason: 'unavailable' }
      }
      return { ok: true, password: password.value, note: note.value }
    }
  )

  handleBrowserPasswordsChannel(
    'browserPasswords:copyPassword',
    async (event, raw): Promise<BrowserPasswordCopyResult> => {
      const request = readBrowserPasswordsVaultRequest(event, raw)
      const entryId = request ? text(request.args.entryId) : ''
      if (!request || !entryId) {
        return { ok: false, reason: 'unavailable' }
      }
      if (!(await confirmBrowserPasswordOwner('copy a saved password'))) {
        return { ok: false, reason: 'auth-failed' }
      }
      const password = request.vault.getPassword(entryId)
      if (!password.ok) {
        return { ok: false, reason: password.reason === 'not-found' ? 'not-found' : 'unavailable' }
      }
      const copied = password.value
      clipboard.writeText(copied)
      setTimeout(() => {
        // Why compare first: never wipe something the user copied afterwards.
        if (clipboard.readText() === copied) {
          clipboard.clear()
        }
      }, CLIPBOARD_CLEAR_MS).unref?.()
      return { ok: true }
    }
  )

  handleBrowserPasswordsChannel(
    'browserPasswords:addEntry',
    (event, raw): BrowserPasswordEntryEditResult => {
      const request = readBrowserPasswordsVaultRequest(event, raw)
      if (!request) {
        return { ok: false, reason: 'unavailable' }
      }
      const origin = siteOrigin(text(request.args.site))
      const username = text(request.args.username).trim()
      if (!origin) {
        return { ok: false, reason: 'invalid-site' }
      }
      const matches = request.vault.findForOrigin(origin)
      if (matches.ok && matches.value.exact.some((entry) => entry.username === username)) {
        return { ok: false, reason: 'duplicate' }
      }
      const added = request.vault.add({ origin, username, password: text(request.args.password) })
      const note = text(request.args.note)
      return editFailure(
        added.ok && note ? request.vault.updateNote(added.value.entry.id, note) : added
      )
    }
  )

  handleBrowserPasswordsChannel(
    'browserPasswords:updateEntry',
    (event, raw): BrowserPasswordEntryEditResult => {
      const request = readBrowserPasswordsVaultRequest(event, raw)
      const entryId = request ? text(request.args.entryId) : ''
      if (!request || !entryId) {
        return { ok: false, reason: 'unavailable' }
      }
      const { vault, args } = request
      const steps = [
        () => vault.updateUsername(entryId, text(args.username).trim()),
        () => vault.updatePassword(entryId, text(args.password)),
        () => vault.updateNote(entryId, text(args.note))
      ]
      for (const step of steps) {
        const result = step()
        if (!result.ok) {
          return editFailure(result)
        }
      }
      return { ok: true }
    }
  )

  handleBrowserPasswordsChannel('browserPasswords:deleteEntry', (event, raw): boolean => {
    const request = readBrowserPasswordsVaultRequest(event, raw)
    const entryId = request ? text(request.args.entryId) : ''
    return Boolean(request && entryId && request.vault.remove(entryId).ok)
  })

  handleBrowserPasswordsChannel(
    'browserPasswords:deleteAll',
    async (event, raw): Promise<boolean> => {
      const request = readBrowserPasswordsVaultRequest(event, raw)
      if (!request) {
        return false
      }
      if (!(await confirmBrowserPasswordOwner('delete all saved passwords', { always: true }))) {
        return false
      }
      return deleteBrowserPasswordVault(request.vault).ok
    }
  )

  handleBrowserPasswordsChannel('browserPasswords:listNever', (event, raw): string[] | null => {
    const listed = readBrowserPasswordsVaultRequest(event, raw)?.vault.listNever()
    return listed?.ok ? listed.value : null
  })

  handleBrowserPasswordsChannel('browserPasswords:removeNever', (event, raw): boolean => {
    const request = readBrowserPasswordsVaultRequest(event, raw)
    const origin = request ? toBrowserPasswordOrigin(text(request.args.origin)) : null
    return Boolean(request && origin && request.vault.removeNever(origin).ok)
  })
}
