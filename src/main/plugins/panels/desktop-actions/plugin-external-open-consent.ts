// @protected-copy: a plugin language pack must not reword what the person is asked to allow.
import type { BrowserWindow } from 'electron'
import type { Store } from '../../../persistence/loading-store/store'
import { translateMain } from '../../../i18n/main-i18n'
import {
  canConfirmInWindow,
  confirmPluginAction,
  type PluginActionConfirmation
} from '../../consent/plugin-action-confirmation'

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

export type PluginExternalOpenConsent = PluginActionConfirmation

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
  if (!canConfirmInWindow(input.window)) {
    input.log?.(
      `shell.openExternal(${host}): not opened; Orca's window is hidden, so nobody can confirm it`
    )
    return 'unavailable'
  }
  input.admit?.()
  input.log?.(`shell.openExternal(${host}): waiting for the person to confirm`)
  const { answer, remember } = await confirmPluginAction(input.window, {
    confirmLabel: translateMain('plugins.frameOpenExternal.open', 'Open'),
    cancelLabel: translateMain('plugins.frameOpenExternal.cancel', 'Cancel'),
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
  if (answer !== 'allowed') {
    return answer
  }
  if (remember) {
    rememberHost(input.store, input.pluginId, host)
  }
  return 'allowed'
}
