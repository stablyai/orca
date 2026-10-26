import { shell } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { parseHttpUrl, SYSTEM_DEFAULT_BROWSER_ID } from '../../shared/external-browser-types'
import { openUrlInInstalledBrowser } from './external-browser-launch'

type ExternalBrowserSettingsReader = () => Pick<GlobalSettings, 'externalBrowserId'>

let readSettings: ExternalBrowserSettingsReader | null = null

export function setExternalBrowserSettingsReader(
  reader: ExternalBrowserSettingsReader | null
): void {
  readSettings = reader
}

export function readConfiguredExternalBrowserId(): string | null {
  return readSettings?.().externalBrowserId ?? null
}

/** Opens http(s) URLs in the explicit browser, else the configured default, else the OS default. */
export async function openExternalUrl(
  rawUrl: string,
  options: { browserId?: string } = {}
): Promise<void> {
  const url = parseHttpUrl(rawUrl)
  if (!url) {
    return
  }
  // Read at call time so a settings change applies to the next open.
  const browserId = options.browserId ?? readConfiguredExternalBrowserId()
  if (browserId && browserId !== SYSTEM_DEFAULT_BROWSER_ID) {
    if (await openUrlInInstalledBrowser(browserId, url)) {
      return
    }
  }
  await shell.openExternal(url)
}
