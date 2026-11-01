import { dialog, type BrowserWindow } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import { translateMain } from '../../i18n/main-i18n'

type GrantStore = Pick<Store, 'getSettings' | 'updateSettings'>

const URL_DETAIL_MAX_LENGTH = 300

function grantedHosts(store: GrantStore, pluginId: string): readonly string[] {
  const hosts = store.getSettings().pluginExternalHostGrants?.[pluginId]
  return Array.isArray(hosts) ? hosts : []
}

function rememberHost(store: GrantStore, pluginId: string, host: string): void {
  const grants = { ...store.getSettings().pluginExternalHostGrants }
  grants[pluginId] = [...new Set([...grantedHosts(store, pluginId), host])]
  store.updateSettings({ pluginExternalHostGrants: grants })
}

export type PluginExternalOpenConsent = 'allowed' | 'cancelled' | 'unavailable'

export function truncatedUrl(url: string): string {
  return url.length > URL_DETAIL_MAX_LENGTH ? `${url.slice(0, URL_DETAIL_MAX_LENGTH - 1)}…` : url
}

/**
 * A frame has no network, but a URL it opens carries whatever it encodes into it. So the person
 * confirms each new host a plugin opens, unless they allowed that host for that plugin before.
 * `mailto:` only fills in a draft the person still sends, so it is not asked about.
 */
export async function confirmPluginExternalOpen(input: {
  window: BrowserWindow
  store: GrantStore
  pluginId: string
  pluginName: string
  url: string
  log?: (line: string) => void
  /** Spends the rate budget (it may throw): before an open or a prompt, never for nothing. */
  admit?: () => void
}): Promise<PluginExternalOpenConsent> {
  const parsed = new URL(input.url)
  // Punycode host (`URL` normalizes it), so a lookalike name shows as what it is.
  const host = parsed.host.toLowerCase()
  if (parsed.protocol === 'mailto:' || grantedHosts(input.store, input.pluginId).includes(host)) {
    input.admit?.()
    return 'allowed'
  }
  // A sheet on a hidden or minimized window would wait, unseen, forever.
  if (input.window.isDestroyed() || !input.window.isVisible() || input.window.isMinimized()) {
    input.log?.(
      `shell.openExternal(${host}): not opened; Orca's window is hidden, so nobody can confirm it`
    )
    return 'unavailable'
  }
  input.admit?.()
  input.log?.(`shell.openExternal(${host}): waiting for the person to confirm`)
  const { response, checkboxChecked } = await dialog.showMessageBox(input.window, {
    type: 'question',
    buttons: [
      translateMain('plugins.frameOpenExternal.open', 'Open'),
      translateMain('plugins.frameOpenExternal.cancel', 'Cancel')
    ],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: translateMain(
      'plugins.frameOpenExternal.message',
      '{{plugin}} wants to open {{host}}',
      {
        plugin: input.pluginName,
        host
      }
    ),
    detail: truncatedUrl(parsed.href),
    checkboxLabel: translateMain(
      'plugins.frameOpenExternal.alwaysAllow',
      'Always allow {{host}} for this plugin',
      { host }
    )
  })
  if (response !== 0) {
    return 'cancelled'
  }
  if (checkboxChecked) {
    rememberHost(input.store, input.pluginId, host)
  }
  return 'allowed'
}
