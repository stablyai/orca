import type { PluginLockEntry } from '../../../shared/plugins/installation/plugin-install-lockfile'
import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../../../shared/plugins/approval/plugin-consent-state'
import type { Store } from '../../persistence/loading-store/store'
import type { PluginService } from '../plugin-service'
import type { PluginConsentRequest } from '../../../shared/plugins/approval/plugin-consent-request'
import { verifyDeclarativePluginContent } from '../artifacts/plugin-declarative-content-integrity'
import { isRequiredTeamPluginInstall } from '../installation/plugin-team-install-policy'

// Desktop and headless writes share qualified-key consent; capability or worker-tier expansion requires reapproval.

/** Approval records current reviewed identity; declining disables future consent prompts. */
export async function applyPluginConsent(input: {
  store: Store
  pluginService: PluginService
  pluginKey: PluginConsentRequest['pluginKey']
  reviewedFingerprint: PluginConsentRequest['reviewedFingerprint']
  decision: PluginConsentRequest['decision']
  teamRequirementStillApplies?: () => boolean
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
  const write = (installed?: PluginLockEntry): void => {
    if (input.teamRequirementStillApplies?.() === false) {
      return
    }
    if (
      input.decision === 'approve' &&
      installed &&
      (installed.contentHash !== plugin.contentHash ||
        installed.version !== plugin.manifest.version)
    ) {
      throw new Error(`plugin ${pluginKey} changed since its permissions were reviewed`)
    }
    if (
      input.decision === 'approve' &&
      pluginService.findValidPlugin(pluginKey)?.consentFingerprint !== input.reviewedFingerprint
    ) {
      throw new Error(`plugin ${pluginKey} changed since its permissions were reviewed`)
    }
    const settings = store.getSettings()
    const disabled = new Set(normalizePluginIdList(settings.disabledPlugins))
    const consents = normalizePluginConsents(settings.pluginConsents)
    if (input.decision === 'approve') {
      consents[pluginKey] = plugin.consentFingerprint
      if (!input.teamRequirementStillApplies) {
        disabled.delete(pluginKey)
      }
    } else {
      disabled.add(pluginKey)
    }
    // Why every window, the clicking one too: its store never applied this write itself, and
    // theme resolution reads `disabledPlugins` from it.
    store.updateSettings(
      { disabledPlugins: [...disabled], pluginConsents: consents },
      { notifyListeners: true }
    )
  }
  await (input.decision === 'approve' &&
  !plugin.isDev &&
  pluginService.options.withMarketplaceApproval
    ? pluginService.options.withMarketplaceApproval(pluginKey, write)
    : write())
  await pluginService.reconcileActivationState()
}

/** Synchronous revocation; reconcile activation only after releasing mutation locks. */
export function revokePluginConsent(input: {
  store: Store
  pluginService: PluginService | null
  pluginKey: string
}): void {
  const { store, pluginService, pluginKey } = input
  // Why throw: an install that cannot drop the old approval must not publish.
  if (!pluginService) {
    throw new Error('plugin service is not running')
  }
  const consents = normalizePluginConsents(store.getSettings().pluginConsents)
  if (!(pluginKey in consents)) {
    return
  }
  delete consents[pluginKey]
  store.updateSettings({ pluginConsents: consents }, { notifyListeners: true })
}

/** Enabling cannot bypass missing/stale consent. */
export async function applyPluginEnablement(input: {
  store: Store
  pluginService: PluginService
  pluginKey: string
  enabled: boolean
}): Promise<void> {
  const { store, pluginService, pluginKey, enabled } = input
  const plugin = pluginService.findValidPlugin(pluginKey)
  if (!plugin) {
    throw new Error(`cannot change enablement for unknown plugin ${pluginKey}`)
  }
  const required = isRequiredTeamPluginInstall(plugin.teamPolicyInstall)
  if (!enabled && required) {
    throw new Error('This plugin is required by your team.')
  }
  if (enabled && required && pluginService.activationState(plugin) === 'approved') {
    if (
      pluginService.workerState(pluginKey).state === 'errored' ||
      pluginService.activationError(pluginKey)
    ) {
      await pluginService.deactivatePlugin(pluginKey)
      await pluginService.reconcileActivationState()
    }
    return
  }
  const settings = store.getSettings()
  const disabled = new Set(normalizePluginIdList(settings.disabledPlugins))
  if (enabled) {
    disabled.delete(pluginKey)
  } else {
    disabled.add(pluginKey)
  }
  store.updateSettings({ disabledPlugins: [...disabled] }, { notifyListeners: true })
  await pluginService.reconcileActivationState()
}
