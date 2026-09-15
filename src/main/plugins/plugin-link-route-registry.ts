import {
  normalizeRoutePattern,
  rankLinkRoutes,
  type LinkRouteDestination,
  type NormalizedLinkRoute
} from '../../shared/plugins/plugin-link-route-matching'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { routePatternViolatesSuffixPolicy } from './plugin-link-route-suffix-policy'

export type PluginLinkRouteRegistration = {
  pluginKey: string
  pluginName: string
  hostname: string
  destination: LinkRouteDestination
  description?: string
  /** Another plugin claims the same hostname, so this route is not published. Copy lives in the
   *  renderer: an English sentence built here would cross IPC untranslated. */
  conflict?: true
}

/**
 * Two distinct views, deliberately not one:
 *  - `declared` is what a plugin asks for, rendered at consent time before approval;
 *  - `list` is approved and conflict-filtered, and is the only set matching ever sees.
 *
 * A conflict is annotated onto the declared route it belongs to, never raised as an activation
 * error. The content-pack registry treats an activation error as fatal and drops the whole plugin,
 * which would let a newly installed plugin disable an approved plugin's unrelated routes.
 */
function hostnamesClaimedMoreThanOnce(
  registrations: readonly PluginLinkRouteRegistration[]
): Set<string> {
  const owners = new Map<string, Set<string>>()
  for (const registration of registrations) {
    const hostOwners = owners.get(registration.hostname) ?? new Set<string>()
    hostOwners.add(registration.pluginKey)
    owners.set(registration.hostname, hostOwners)
  }
  return new Set(
    [...owners.entries()]
      .filter(([, hostOwners]) => hostOwners.size > 1)
      .map(([hostname]) => hostname)
  )
}

export class PluginLinkRouteRegistry {
  private active: NormalizedLinkRoute[] = []
  private readonly declaredByPlugin = new Map<string, PluginLinkRouteRegistration[]>()

  /** Approved, conflict-filtered and ranked. First match wins. */
  list(): readonly NormalizedLinkRoute[] {
    return this.active
  }

  /** Everything the plugin declares, approved or not, each annotated with its conflict. */
  declared(pluginKey: string): readonly PluginLinkRouteRegistration[] {
    return this.declaredByPlugin.get(pluginKey) ?? []
  }

  reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  ): void {
    this.declaredByPlugin.clear()

    const candidates = discovered.filter(
      (plugin): plugin is ValidDiscoveredPlugin =>
        !isInvalidDiscoveredPlugin(plugin) && plugin.manifest.contributes.linkRoutes.length > 0
    )

    const approvedRoutes: {
      route: NormalizedLinkRoute
      registration: PluginLinkRouteRegistration
    }[] = []
    for (const plugin of candidates) {
      const registrations: PluginLinkRouteRegistration[] = []
      const approved = isApproved(plugin)
      for (const [index, contribution] of plugin.manifest.contributes.linkRoutes.entries()) {
        const registration: PluginLinkRouteRegistration = {
          pluginKey: plugin.pluginKey,
          pluginName: plugin.manifest.name,
          hostname: contribution.hostname,
          destination: contribution.destination,
          description: contribution.description
        }
        registrations.push(registration)
        const pattern = normalizeRoutePattern(contribution.hostname)
        // Discovery rejects these before publication; belt and braces so a future caller that skips
        // validation cannot install an unchecked pattern.
        if (!approved || !pattern || routePatternViolatesSuffixPolicy(pattern)) {
          continue
        }
        approvedRoutes.push({
          route: {
            pattern,
            destination: contribution.destination,
            pluginKey: plugin.pluginKey,
            index
          },
          registration
        })
      }
      this.declaredByPlugin.set(plugin.pluginKey, registrations)
    }

    // Two different questions, deliberately two different sets.
    // Publication asks "do two APPROVED plugins claim this?" — only those can contend for the table.
    // Consent asks "does anyone else claim this?", including plugins still pending, because that is
    // the warning the user needs while deciding. Computing both from approved-only would leave a
    // pending plugin's colliding route silently unflagged at the one moment it matters.
    const contestedAmongApproved = hostnamesClaimedMoreThanOnce(
      approvedRoutes.map(({ registration }) => registration)
    )
    const contestedAmongDeclared = hostnamesClaimedMoreThanOnce(
      [...this.declaredByPlugin.values()].flat()
    )
    // Annotate in place so a conflict is always read from the route it belongs to, never by index.
    for (const registrations of this.declaredByPlugin.values()) {
      for (const registration of registrations) {
        if (contestedAmongDeclared.has(registration.hostname)) {
          registration.conflict = true
        }
      }
    }

    const surviving = approvedRoutes.filter(
      ({ registration }) => !contestedAmongApproved.has(registration.hostname)
    )
    this.active = rankLinkRoutes(surviving.map(({ route }) => route))
  }
}
