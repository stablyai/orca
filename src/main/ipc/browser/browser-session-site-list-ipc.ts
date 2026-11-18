import { BrowserWindow, dialog, ipcMain } from 'electron'
import { translateMain } from '../../i18n/main-i18n'
import { browserSessionRegistry } from '../../browser/sessions/profiles/browser-session-registry'
import {
  areBrowserProfileSiteListsReadable,
  saveBrowserProfileSiteList
} from '../../browser/sessions/site-list/browser-profile-site-list-store'
import { getBrowserProfileSiteListEntries } from '../../browser/sessions/site-list/browser-session-site-list'
import {
  compileBrowserSiteList,
  isSiteListEntryCovered,
  normalizeBrowserSiteListEntries
} from '../../../shared/browser/profiles/browser-profile-site-list'
import type { BrowserSiteListSetResult } from '../../../shared/browser/profiles/browser-profile-site-list'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

const MAX_HOSTS_IN_DIALOG = 15

// One edit at a time: the dialog is async, so two edits must not both judge against the same list.
let editQueue: Promise<unknown> = Promise.resolve()
function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const run = editQueue.then(task, task)
  editQueue = run.catch(() => undefined)
  return run
}

/** Hosts an edit adds beyond the list enforced right now; null when it does not widen. */
function wideningAgainstCurrent(profileId: string, entries: string[]): string[] | null {
  const current = getBrowserProfileSiteListEntries(profileId)
  if (current.length === 0) {
    return null
  }
  const currentList = compileBrowserSiteList(current)
  const added = entries.filter((entry) => !isSiteListEntryCovered(currentList, entry))
  return entries.length === 0 || added.length > 0 ? added : null
}

function describeWidening(added: string[]): string {
  if (added.length === 0) {
    return translateMain(
      'browser.siteList.confirmClearDetail',
      'The site list will be removed, so this profile can open any site.'
    )
  }
  const shown = added.slice(0, MAX_HOSTS_IN_DIALOG).join('\n')
  const more =
    added.length > MAX_HOSTS_IN_DIALOG
      ? `\n${translateMain('browser.siteList.confirmMore', 'and {{extra}} more', {
          extra: added.length - MAX_HOSTS_IN_DIALOG
        })}`
      : ''
  return `${translateMain('browser.siteList.confirmAddDetail', 'This profile will also be able to open:')}\n\n${shown}${more}`
}

async function confirmWidening(
  window: BrowserWindow | null,
  profileLabel: string,
  added: string[]
): Promise<boolean> {
  if (!window || window.isDestroyed()) {
    return false
  }
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: [
      translateMain('browser.siteList.confirmAllow', 'Allow'),
      translateMain('browser.siteList.confirmCancel', 'Cancel')
    ],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: translateMain(
      'browser.siteList.confirmTitle',
      'Allow more sites in the browser profile "{{profile}}"?',
      { profile: profileLabel }
    ),
    detail: describeWidening(added)
  })
  return response === 0
}

async function applyEdit(
  event: Electron.IpcMainInvokeEvent,
  profileId: string,
  entries: string[]
): Promise<BrowserSiteListSetResult> {
  if (!areBrowserProfileSiteListsReadable()) {
    return { ok: false, reason: 'load-failed' }
  }
  const profile = browserSessionRegistry.getProfile(profileId)
  if (!profile) {
    return { ok: false, reason: 'unavailable' }
  }
  const added = wideningAgainstCurrent(profile.id, entries)
  if (added !== null) {
    if (!(await confirmWidening(BrowserWindow.fromWebContents(event.sender), profile.label, added))) {
      return { ok: false, reason: 'cancelled' }
    }
    // The owner approved exactly `added`. If the list or profile changed during the dialog and the
    // edit now widens by anything else, refuse instead of prompting again.
    const after = wideningAgainstCurrent(profile.id, entries)
    if (!browserSessionRegistry.getProfile(profile.id)) {
      return { ok: false, reason: 'unavailable' }
    }
    if (after !== null && !after.every((host) => added.includes(host))) {
      return { ok: false, reason: 'changed' }
    }
  }
  const saved = saveBrowserProfileSiteList(profile.id, entries)
  if (saved === 'unreadable') {
    return { ok: false, reason: 'load-failed' }
  }
  return saved === 'saved' ? { ok: true, hosts: entries } : { ok: false, reason: 'save-failed' }
}

// Renderer-only: agents driving the browser (runtime RPC, CLI) must not be able to edit the list.
export function registerBrowserSessionSiteListHandlers(): void {
  ipcMain.removeHandler('browser:session:getAllowedHosts')
  ipcMain.removeHandler('browser:session:setAllowedHosts')

  ipcMain.handle(
    'browser:session:getAllowedHosts',
    (event, args: { profileId: string }): string[] | null => {
      // null: the caller is untrusted, the profile is gone, or the saved lists cannot be read.
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        !browserSessionRegistry.getProfile(args.profileId) ||
        !areBrowserProfileSiteListsReadable()
      ) {
        return null
      }
      return getBrowserProfileSiteListEntries(args.profileId)
    }
  )

  ipcMain.handle(
    'browser:session:setAllowedHosts',
    async (
      event,
      args: { profileId: string; hosts: unknown }
    ): Promise<BrowserSiteListSetResult> => {
      const profile = isTrustedBrowserRenderer(event.sender)
        ? browserSessionRegistry.getProfile(args.profileId)
        : null
      if (!profile) {
        return { ok: false, reason: 'unavailable' }
      }
      if (!Array.isArray(args.hosts) || !args.hosts.every((host) => typeof host === 'string')) {
        return { ok: false, reason: 'invalid' }
      }
      const parsed = normalizeBrowserSiteListEntries(args.hosts)
      if (!parsed.ok) {
        return { ok: false, reason: 'invalid' }
      }
      return runSerialized(() => applyEdit(event, profile.id, parsed.entries))
    }
  )
}
