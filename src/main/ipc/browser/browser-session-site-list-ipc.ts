import { BrowserWindow, dialog, ipcMain } from 'electron'
import { translateMain } from '../../i18n/main-i18n'
import { browserSessionRegistry } from '../../browser/sessions/profiles/browser-session-registry'
import {
  compileBrowserSiteList,
  isSiteListEntryCovered,
  normalizeBrowserSiteListEntries
} from '../../../shared/browser/profiles/browser-profile-site-list'
import type { BrowserSiteListSetResult } from '../../../shared/browser/profiles/browser-profile-site-list-ipc'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

const MAX_HOSTS_IN_DIALOG = 15

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

// Renderer-only: agents driving the browser (runtime RPC, CLI) must not be able to edit the list.
export function registerBrowserSessionSiteListHandlers(): void {
  ipcMain.removeHandler('browser:session:getAllowedHosts')
  ipcMain.removeHandler('browser:session:setAllowedHosts')

  ipcMain.handle(
    'browser:session:getAllowedHosts',
    (event, args: { profileId: string }): string[] => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        !browserSessionRegistry.getProfile(args.profileId)
      ) {
        return []
      }
      return browserSessionRegistry.getAllowedHosts(args.profileId)
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
      const current = browserSessionRegistry.getAllowedHosts(profile.id)
      if (current.length > 0) {
        const currentList = compileBrowserSiteList(current)
        const added = parsed.entries.filter((entry) => !isSiteListEntryCovered(currentList, entry))
        const widens = parsed.entries.length === 0 || added.length > 0
        if (widens) {
          const window = BrowserWindow.fromWebContents(event.sender)
          if (!(await confirmWidening(window, profile.label, added))) {
            return { ok: false, reason: 'cancelled' }
          }
        }
      }
      browserSessionRegistry.setAllowedHosts(profile.id, parsed.entries)
      return { ok: true, hosts: parsed.entries }
    }
  )
}
