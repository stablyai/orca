import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { applyElectronProxySettings } from '../network/proxy-settings'
import { applyBrowserSessionProxies } from '../browser/sessions/proxy/browser-session-proxy'
import { applyProxyToElectronUpdaterSession } from '../updater/lifecycle/electron-updater-proxy-session'
import { browserSessionRegistry } from '../browser/sessions/profiles/browser-session-registry'

export async function applyNetworkSettings(
  before: GlobalSettings,
  result: GlobalSettings,
  sanitizedArgs: Partial<GlobalSettings>
): Promise<Error | null> {
  const proxySettingsChanged =
    ('httpProxyUrl' in sanitizedArgs && before.httpProxyUrl !== result.httpProxyUrl) ||
    ('httpProxyBypassRules' in sanitizedArgs &&
      before.httpProxyBypassRules !== result.httpProxyBypassRules)
  const tlsSettingsUpdated =
    'httpProxyCaCertificate' in sanitizedArgs || 'httpProxyIgnoreCertificateErrors' in sanitizedArgs
  if (proxySettingsChanged || tlsSettingsUpdated) {
    // Start every authority before yielding so requests cannot enter between their barriers.
    const [defaultSessionResult, browserSessionsResult] = await Promise.allSettled([
      applyElectronProxySettings(result),
      proxySettingsChanged
        ? applyBrowserSessionProxies(browserSessionRegistry.listProfiles(), result)
        : Promise.resolve(),
      proxySettingsChanged ? applyProxyToElectronUpdaterSession(result) : Promise.resolve()
    ])
    if (defaultSessionResult.status === 'rejected') {
      console.warn('[settings] failed to apply network proxy settings')
    }
    if (browserSessionsResult.status === 'rejected') {
      console.warn('[settings] failed to apply network proxy settings to browser sessions')
    }
    if (defaultSessionResult.status === 'rejected' && tlsSettingsUpdated) {
      return new Error('Could not apply network TLS settings. Try saving again.')
    }
  }
  return null
}
