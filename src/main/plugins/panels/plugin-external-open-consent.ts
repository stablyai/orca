import { dialog, type BrowserWindow } from 'electron'
import type { Store } from '../../persistence'
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
}): Promise<boolean> {
  const parsed = new URL(input.url)
  if (parsed.protocol === 'mailto:') {
    return true
  }
  // Punycode host (`URL` normalizes it), so a lookalike name shows as what it is.
  const host = parsed.host.toLowerCase()
  if (grantedHosts(input.store, input.pluginId).includes(host)) {
    return true
  }
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
    return false
  }
  if (checkboxChecked) {
    rememberHost(input.store, input.pluginId, host)
  }
  return true
}
