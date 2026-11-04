import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../../shared/plugins/approval/plugin-consent-state'
import type { Store } from '../persistence'
import type { PluginService } from './plugin-service'
import type { PluginConsentRequest } from '../../shared/plugins/approval/plugin-consent-request'
import { verifyDeclarativePluginContent } from './plugin-declarative-content-integrity'

// Desktop and headless writes share qualified-key consent; capability or worker-tier expansion requires reapproval.

/** Approval records current reviewed identity; declining disables future consent prompts. */
export async function applyPluginConsent(input: {
  store: Store
  pluginService: PluginService
  pluginKey: PluginConsentRequest['pluginKey']
  reviewedFingerprint: PluginConsentRequest['reviewedFingerprint']
  decision: PluginConsentRequest['decision']
  originWebContentsId?: number
}): Promise<void> {
  const { store, pluginService, pluginKey } = input
  const plugin = pluginService.findValidPlugin(pluginKey)
  if (!plugin) {
    throw new Error(`cannot record consent for unknown plugin ${pluginKey}`)
  }
  // Same-key installs may change while the dialog is open; bind consent to the reviewed fingerprint.
  if (input.decision === 'approve' && plugin.consentFingerprint !== input.reviewedFingerprint) {
    throw new Error(`plugin ${pluginKey} changed since its permissions were reviewed`)
  }
  if (input.decision === 'approve') {
    // Why: IPC and serve callers can bypass the renderer dialog, so main must
    // prove every declarative byte is still reviewable before enabling it.
    await verifyDeclarativePluginContent(plugin)
  }
  const settings = store.getSettings()
  const disabled = new Set(normalizePluginIdList(settings.disabledPlugins))
  const consents = normalizePluginConsents(settings.pluginConsents)
  if (input.decision === 'approve') {
    consents[pluginKey] = plugin.consentFingerprint
    disabled.delete(pluginKey)
  } else {
    disabled.add(pluginKey)
  }
  store.updateSettings(
    { disabledPlugins: [...disabled], pluginConsents: consents },
    { notifyListeners: true, originWebContentsId: input.originWebContentsId }
  )
  await pluginService.reconcileActivationState()
}

/** Enabling cannot bypass missing/stale consent. */
export async function applyPluginEnablement(input: {
  store: Store
  pluginService: PluginService
  pluginKey: string
  enabled: boolean
  originWebContentsId?: number
}): Promise<void> {
  const { store, pluginService, pluginKey, enabled } = input
  const plugin = pluginService.findValidPlugin(pluginKey)
  if (!plugin) {
    throw new Error(`cannot change enablement for unknown plugin ${pluginKey}`)
  }
  const settings = store.getSettings()
  const disabled = new Set(normalizePluginIdList(settings.disabledPlugins))
  if (enabled) {
    disabled.delete(pluginKey)
  } else {
    disabled.add(pluginKey)
  }
  store.updateSettings(
    { disabledPlugins: [...disabled] },
    { notifyListeners: true, originWebContentsId: input.originWebContentsId }
  )
  await pluginService.reconcileActivationState()
}
