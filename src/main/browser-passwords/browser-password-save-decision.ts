import type { BrowserPasswordFormKind } from '../../shared/browser-passwords-types'

export type BrowserPasswordSavedLogin = { id: string; username: string; password: string }

export type BrowserPasswordSaveDecision =
  | { kind: 'none'; usedEntryId: string | null }
  | { kind: 'save'; username: string; password: string }
  | { kind: 'update'; entryId: string; username: string; password: string }

/**
 * Chrome's save-or-update table for a login that succeeded, against the logins already saved for
 * the exact origin: a known pair only refreshes last-used, a known username with a new password is
 * an update, anything else is a new save.
 */
export function decideBrowserPasswordSave(input: {
  username: string | null
  password: string
  formKind: BrowserPasswordFormKind
  saved: BrowserPasswordSavedLogin[]
}): BrowserPasswordSaveDecision {
  const username = input.username?.trim() ?? ''
  if (username) {
    const sameUser = input.saved.find((login) => login.username === username)
    if (!sameUser) {
      return { kind: 'save', username, password: input.password }
    }
    return sameUser.password === input.password
      ? { kind: 'none', usedEntryId: sameUser.id }
      : { kind: 'update', entryId: sameUser.id, username, password: input.password }
  }
  // No username field (re-auth prompts, change-password pages): match by password instead.
  const samePassword = input.saved.find((login) => login.password === input.password)
  if (samePassword) {
    return { kind: 'none', usedEntryId: samePassword.id }
  }
  const onlySaved = input.saved.length === 1 ? input.saved[0] : undefined
  if (input.formKind === 'change' && onlySaved) {
    return {
      kind: 'update',
      entryId: onlySaved.id,
      username: onlySaved.username,
      password: input.password
    }
  }
  return { kind: 'save', username: '', password: input.password }
}
