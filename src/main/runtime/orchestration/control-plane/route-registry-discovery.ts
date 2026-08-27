import { hasAgentHookIngestion } from '../../../../shared/agent-hook-types'
import {
  findCatalogModel,
  findCatalogOption,
  getAgentSessionOptionCatalog
} from '../../../../shared/agent-session-option-catalog'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  routeKey,
  unknownReadiness,
  UNKNOWN,
  type RouteIdentity,
  type RouteRow
} from './route-registry-types'

/** CORRECTION 1 — the registry is built from the EXISTING authoritative
 *  ownership (the launcher config, the managed agent-hook target list and the
 *  session-option catalog), not from prose about which models are good.
 *
 *  Discovery declares eligibility and identity proof only. It never sets a
 *  certification state: that comes solely from recorded runtime evidence.
 */

export function isLauncherSupported(agent: string): agent is TuiAgent {
  return isTuiAgent(agent) && Boolean(TUI_AGENT_CONFIG[agent])
}

/** Why not `AGENT_HOOK_TARGETS` alone: that list is only the agents Orca
 *  installs managed hook scripts for. An agent shipping its own plugin
 *  (opencode) ingests hooks too, and reading only the managed list made drift
 *  detection report it as `launcher_supported_hook_rejected` while the route
 *  contract said its hook path was fine. */
export function isHookSupported(agent: string): boolean {
  return hasAgentHookIngestion(agent)
}

/** `exact` only when the catalog names this exact model id. A generic family
 *  alias (`opus`, `sonnet`, `gemini-flash-latest`) is `alias`; an id the
 *  catalog has never heard of is UNKNOWN until a provider receipt resolves it. */
export function classifyIdentityProof(
  agent: TuiAgent,
  model: string | null
): RouteRow['identityProof'] {
  if (!model) {
    return UNKNOWN
  }
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog) {
    return UNKNOWN
  }
  const known = findCatalogModel(catalog, model)
  if (!known) {
    return UNKNOWN
  }
  // Why the version test: a family alias resolves to whatever the host CLI has
  // installed today, so it can never prove an exact model/version identity.
  return /\d/.test(model) ? 'exact' : 'alias'
}

export function discoverReasoningModes(agent: TuiAgent, model: string | null): string[] {
  const catalog = model ? getAgentSessionOptionCatalog(agent) : null
  if (!catalog) {
    return []
  }
  const option =
    findCatalogOption(findCatalogModel(catalog, model as string), 'effort') ??
    catalog.unknownModelOptions?.find((candidate) => candidate.id === 'effort')
  return option?.kind.type === 'select' ? option.kind.choices.map((choice) => choice.value) : []
}

export type RouteCandidateDeclaration = {
  identity: RouteIdentity
  provider?: string
  harness?: string
  roles?: RouteRow['roles']
  taskCapabilities?: RouteRow['taskCapabilities']
  sessionModes?: RouteRow['sessionModes']
  contextLimitTokens?: RouteRow['contextLimitTokens']
  costClass?: RouteRow['costClass']
  constraints?: readonly string[]
  notes?: string | null
  readiness?: RouteRow['readiness']
}

/** Builds a registry row from a declaration plus discovered runtime truth.
 *  Every field the runtime cannot observe stays UNKNOWN. */
export function buildRouteRow(declaration: RouteCandidateDeclaration): RouteRow {
  const agent = declaration.identity.agent
  return {
    identity: declaration.identity,
    provider: declaration.provider ?? UNKNOWN,
    harness: declaration.harness ?? UNKNOWN,
    roles: declaration.roles ?? [],
    taskCapabilities: declaration.taskCapabilities ?? [],
    sessionModes: declaration.sessionModes ?? [],
    reasoningModes: discoverReasoningModes(agent, declaration.identity.model),
    contextLimitTokens: declaration.contextLimitTokens ?? UNKNOWN,
    costClass: declaration.costClass ?? UNKNOWN,
    identityProof: classifyIdentityProof(agent, declaration.identity.model),
    launcherSupported: isLauncherSupported(agent),
    hookSupported: isHookSupported(agent),
    readiness: declaration.readiness ?? unknownReadiness(),
    constraints: declaration.constraints ?? [],
    notes: declaration.notes ?? null
  }
}

export type RegistryDriftFault = {
  routeKey: string
  code:
    | 'launcher_supported_hook_rejected'
    | 'model_absent_from_catalog'
    | 'reasoning_absent_from_catalog'
    | 'launcher_unsupported'
  reason: string
}

/** The consistency gate CORRECTION 1 requires: a provider/model must not be
 *  launcher-supported and hook-rejected, and a declared model or reasoning mode
 *  must exist in the authoritative catalog. Run this before real work; a fault
 *  here means the registry disagrees with the code that will actually launch. */
export function findRegistryDrift(registry: readonly RouteRow[]): RegistryDriftFault[] {
  const faults: RegistryDriftFault[] = []
  for (const route of registry) {
    const key = routeKey(route.identity)
    if (!route.launcherSupported) {
      faults.push({
        routeKey: key,
        code: 'launcher_unsupported',
        reason: `${route.identity.agent} has no Orca launcher configuration.`
      })
      continue
    }
    if (!route.hookSupported) {
      faults.push({
        routeKey: key,
        code: 'launcher_supported_hook_rejected',
        reason: `${route.identity.agent} launches but is not a managed agent-hook target, so PreTool policy would reject it mid-run.`
      })
    }
    const catalog = getAgentSessionOptionCatalog(route.identity.agent)
    if (route.identity.model && catalog && !findCatalogModel(catalog, route.identity.model)) {
      faults.push({
        routeKey: key,
        code: 'model_absent_from_catalog',
        reason: `Model ${route.identity.model} is not in the ${route.identity.agent} session-option catalog.`
      })
    }
    const declaredReasoning = route.identity.reasoning
    if (declaredReasoning && !route.reasoningModes.includes(declaredReasoning)) {
      faults.push({
        routeKey: key,
        code: 'reasoning_absent_from_catalog',
        reason: `Reasoning ${declaredReasoning} is not offered for ${route.identity.agent}/${route.identity.model ?? '<none>'}.`
      })
    }
  }
  return faults
}
