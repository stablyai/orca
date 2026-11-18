import { BrowserWindow, dialog, ipcMain } from 'electron'
import { translateMain } from '../../i18n/main-i18n'
import { browserSessionRegistry } from '../../browser/sessions/profiles/browser-session-registry'
import {
  ensureBrowserProfileSiteListsLoaded,
  saveBrowserProfileSiteList
} from '../../browser/sessions/site-list/browser-profile-site-list-store'
import { getBrowserProfileSiteListEntries } from '../../browser/sessions/site-list/browser-session-site-list'
import { canConfirmInWindow } from '../../plugins/consent/plugin-action-confirmation'
import {
  compileBrowserSiteList,
  isSiteListEntryCovered,
  normalizeBrowserSiteListEntries
} from '../../../shared/browser/profiles/browser-profile-site-list'
import type { BrowserSiteListSetResult } from '../../../shared/browser/profiles/browser-profile-site-list'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

const MAX_HOSTS_IN_DIALOG = 15

// Edits run one at a time: the dialog is async, so a second must see the first's result.
let editQueue: Promise<unknown> = Promise.resolve()

/** Hosts an edit adds beyond the enforced list; [] when it clears it, null when it only narrows. */
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
  const more = added.length - MAX_HOSTS_IN_DIALOG
  const lines = added.slice(0, MAX_HOSTS_IN_DIALOG)
  if (more > 0) {
    lines.push(translateMain('browser.siteList.confirmMore', 'and {{more}} more', { more }))
  }
  const intro = translateMain(
    'browser.siteList.confirmAddDetail',
    'This profile will also be able to open:'
  )
  return `${intro}\n\n${lines.join('\n')}`
}

async function confirmWidening(
  window: BrowserWindow | null,
  profileLabel: string,
  added: string[]
): Promise<boolean> {
  if (!canConfirmInWindow(window)) {
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
  profileLabel: string,
  entries: string[]
): Promise<BrowserSiteListSetResult> {
  if (!(await ensureBrowserProfileSiteListsLoaded())) {
    return { ok: false, reason: 'save-failed' }
  }
  const added = wideningAgainstCurrent(profileId, entries)
  if (
    added !== null &&
    !(await confirmWidening(BrowserWindow.fromWebContents(event.sender), profileLabel, added))
  ) {
    return { ok: false, reason: 'cancelled' }
  }
  if (!browserSessionRegistry.getProfile(profileId)) {
    return { ok: false, reason: 'unavailable' }
  }
  return (await saveBrowserProfileSiteList(profileId, entries))
    ? { ok: true, hosts: entries }
    : { ok: false, reason: 'save-failed' }
}

// Renderer-only: agents driving the browser (runtime RPC, CLI) must not be able to edit the list.
export function registerBrowserSessionSiteListHandlers(): void {
  ipcMain.removeHandler('browser:session:getAllowedHosts')
  ipcMain.removeHandler('browser:session:setAllowedHosts')

  ipcMain.handle(
    'browser:session:getAllowedHosts',
    async (event, args: { profileId: string }): Promise<string[] | null> =>
      isTrustedBrowserRenderer(event.sender) &&
      browserSessionRegistry.getProfile(args.profileId) &&
      (await ensureBrowserProfileSiteListsLoaded())
        ? getBrowserProfileSiteListEntries(args.profileId)
        : null
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
      const hosts = args.hosts
      const parsed =
        Array.isArray(hosts) && hosts.every((host) => typeof host === 'string')
          ? normalizeBrowserSiteListEntries(hosts)
          : null
      if (!parsed?.ok) {
        return { ok: false, reason: 'invalid' }
      }
      const run = editQueue.then(() => applyEdit(event, profile.id, profile.label, parsed.entries))
      editQueue = run.catch(() => undefined)
      return run
    }
  )
}
