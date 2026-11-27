import { readBrowserGuestCurrentFormData } from './manager/registration/browser-page-state-form-data'
import {
  noteBrowserGuestFormData,
  readBrowserGuestDiscardProtection
} from './manager/registration/browser-guest-discard-protection'

/** The guest's own state allows freeing it; page-memory pages also check their claims. */
export function canFreeBrowserGuest(guest: Electron.WebContents): boolean {
  return !(
    guest.isDestroyed() ||
    guest.isLoading() ||
    guest.isDevToolsOpened() ||
    guest.debugger.isAttached() ||
    readBrowserGuestDiscardProtection(guest).protection !== 'discardable'
  )
}

/** A restore reloads with GET, so a page showing a form POST result would come back as another page. */
export function browserGuestShowsFormPost(guest: Electron.WebContents): boolean {
  try {
    // Read from the current entry alone, so a refusal never exports the whole history.
    const formData = readBrowserGuestCurrentFormData(guest)
    noteBrowserGuestFormData(guest, formData)
    return formData !== 'none'
  } catch {
    return true
  }
}
