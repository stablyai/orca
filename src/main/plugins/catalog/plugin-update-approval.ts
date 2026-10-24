import {
  pluginUpdateAccessGrowth,
  pluginUpdateGrowsAccess
} from '../../../shared/plugins/approval/plugin-update-access-growth'
import { livePluginActivationState, type PluginPolicySource } from '../plugin-activation-policy'
import type { PluginMarketplaceInstallResult } from './plugin-marketplace-installer'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import { enableIfDataPlugin } from './plugin-one-click-enable'

/** The installed plugin an update would replace, when it is running under a user approval. */
export function readApprovedPredecessor(
  source: PluginPolicySource,
  plugin: ValidDiscoveredPlugin | null
): ValidDiscoveredPlugin | null {
  // Why dev excluded: a development folder shadows the install, so its approval is not the install's.
  if (!plugin || plugin.isDev || livePluginActivationState(source, plugin) !== 'approved') {
    return null
  }
  return plugin
}

/**
 * Trust once per access level: an update from the same repository that asks for nothing new keeps
 * the approval of the version it replaces, code changes included. Returns whether it was carried.
 */
async function carryPluginApprovalAcrossUpdate(input: {
  previous: ValidDiscoveredPlugin | null
  installedFingerprint: string
  findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  approve: (pluginKey: string, reviewedFingerprint: string) => Promise<void>
}): Promise<boolean> {
  const { previous } = input
  if (!previous) {
    return false
  }
  const next = input.findValidPlugin(previous.pluginKey)
  if (!next || next.isDev || next.consentFingerprint !== input.installedFingerprint) {
    return false
  }
  if (next.consentFingerprint === previous.consentFingerprint) {
    return true
  }
  if (pluginUpdateGrowsAccess(pluginUpdateAccessGrowth(previous.manifest, next.manifest))) {
    return false
  }
  try {
    await input.approve(next.pluginKey, next.consentFingerprint)
    return true
  } catch (error) {
    // Why not thrown: the update installed; it simply waits for review like a first install.
    console.warn(`[plugins] kept ${next.pluginKey} for review after update:`, error)
    return false
  }
}

type InstallingPluginService = {
  readonly options: PluginPolicySource
  findValidPlugin: (pluginKey: string) => ValidDiscoveredPlugin | null
  refresh: () => Promise<void>
}

export type PluginCatalogInstallOutcome = PluginMarketplaceInstallResult & { needsReview?: boolean }

/** Installs a catalog release and settles its approval: kept across a same-access update, granted
 *  for a content-only one-click install, else left for review. Shared by Update and auto-update. */
export async function installCatalogReleaseWithApproval(input: {
  pluginKey: string
  pluginService: InstallingPluginService
  install: () => Promise<PluginMarketplaceInstallResult>
  approve: (pluginKey: string, reviewedFingerprint: string) => Promise<void>
  /** One-click consent for a content-only plugin; the preview's fingerprint when known. */
  enableIfData?: { expectedFingerprint?: string }
}): Promise<PluginCatalogInstallOutcome> {
  const { pluginService } = input
  // Why read first: the install replaces the version whose approval an update may keep.
  const predecessor = readApprovedPredecessor(
    pluginService.options,
    pluginService.findValidPlugin(input.pluginKey)
  )
  const result = await input.install()
  if (!result.ok) {
    return result
  }
  await pluginService.refresh()
  // Why main decides: a repository move must reach review even if the renderer skipped its flag.
  if (result.repositoryMoved) {
    return { ...result, needsReview: true }
  }
  const findValidPlugin = (key: string): ValidDiscoveredPlugin | null =>
    pluginService.findValidPlugin(key)
  if (
    await carryPluginApprovalAcrossUpdate({
      previous: predecessor,
      installedFingerprint: result.consentFingerprint,
      findValidPlugin,
      approve: input.approve
    })
  ) {
    return { ...result, needsReview: false }
  }
  if (!input.enableIfData) {
    return predecessor ? { ...result, needsReview: true } : result
  }
  const { expectedFingerprint } = input.enableIfData
  const { needsReview } = await enableIfDataPlugin({
    pluginKey: result.pluginKey,
    installedFingerprint: result.consentFingerprint,
    ...(expectedFingerprint ? { expectedFingerprint } : {}),
    findValidPlugin,
    approve: input.approve
  })
  return { ...result, needsReview }
}
