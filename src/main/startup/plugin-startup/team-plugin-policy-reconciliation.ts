import {
  getActiveTeamCapabilities,
  onTeamCapabilitiesInvalidated
} from '../../orca-profiles/cloud-auth/active-team-capabilities'
import type { PluginMarketplaceService } from '../../plugins/catalog/plugin-marketplace-service'
import type { PluginMarketplaceInstaller } from '../../plugins/catalog/plugin-marketplace-installer'
import type { PluginService } from '../../plugins/plugin-service'
import { installRequiredTeamPlugins } from '../../plugins/catalog/required-team-plugin-installation'
import { ORCA_CLOUD_TEAM_POLICY_FLAGS as flags } from '../../../shared/orca-profiles/orca-cloud-team-policy'

export function watchTeamPluginPolicy(
  plugins: PluginService,
  marketplace: PluginMarketplaceService,
  installer: PluginMarketplaceInstaller,
  scheduleDelayMs: number
): () => void {
  let lastSnapshot: string | undefined
  let disposed = false
  let lastAttemptAt = 0
  let pending = Promise.resolve()

  const reconcile = (): void => {
    const team = getActiveTeamCapabilities()
    const policy = team?.teamPolicy
    const snapshot = policy
      ? JSON.stringify([
          policy.orgId,
          policy.internalCatalog,
          policy.requiredPlugins,
          team?.flags[flags.plugins],
          team?.flags[flags.officialPlugins],
          team?.flags[flags.communityPlugins]
        ])
      : undefined
    const changed = snapshot !== lastSnapshot
    const retry = policy?.requiredPlugins?.length && Date.now() - lastAttemptAt >= 15 * 60_000
    if (!changed && !retry) {
      return
    }
    lastSnapshot = snapshot
    lastAttemptAt = Date.now()
    pending = pending
      .then(async () => {
        if (disposed || lastSnapshot !== snapshot) {
          return
        }
        if (changed) {
          await plugins.refresh()
        }
        await installRequiredTeamPlugins(marketplace, installer, plugins)
      })
      .catch((error) => {
        console.warn('[plugins] could not apply the team plugin policy:', error)
      })
  }

  const unsubscribe = onTeamCapabilitiesInvalidated(reconcile)
  const initial = setTimeout(reconcile, scheduleDelayMs)
  initial.unref?.()
  return () => {
    disposed = true
    clearTimeout(initial)
    unsubscribe()
  }
}
