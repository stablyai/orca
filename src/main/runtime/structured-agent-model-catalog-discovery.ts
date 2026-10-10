// Each registered agent's catalog probe, built from the SAME resolvers its session launches use:
// a probe under another binary or env could list models the user's sessions cannot see.

import { createAcpModelCatalogProbe } from '../acp/acp-model-catalog-probe'
import type { AcpLaunchSpec } from '../acp/acp-launch-specs'
import { createClaudeModelCatalogProbe } from '../claude/claude-model-catalog-probe'
import { createCodexModelCatalogProbe } from '../codex/codex-model-catalog-probe'
import type { AgentModelCatalogDiscovery } from '../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import type { StructuredAgentModelCatalogContext } from './structured-agent-runtime-registrations'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

/** Claude's overlay, laid over its base env minus an inherited config dir; absent when none. */
export function claudeLaunchEnvOverlay(
  deps: Pick<StructuredAgentSessionRuntimeDeps, 'resolveAgentLaunchEnv'>
): { resolveEnv?: () => Record<string, string> } {
  const resolve = deps.resolveAgentLaunchEnv
  return resolve ? { resolveEnv: () => resolve('claude') } : {}
}

export function codexModelCatalogDiscovery({
  deps,
  environment
}: StructuredAgentModelCatalogContext): AgentModelCatalogDiscovery {
  return {
    kind: 'probe',
    // `model/list` marks the account's configured model as its default.
    listingNamesConfiguredModel: true,
    probe: createCodexModelCatalogProbe({
      resolveAccountKind: deps.resolveCodexAccountKind,
      ...(deps.prepareCodexCatalogProbeHome
        ? { prepareHome: deps.prepareCodexCatalogProbeHome }
        : {}),
      resolveEnvironment: () => environment.resolveAgentEnvironment('codex'),
      ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {})
    })
  }
}

export function claudeModelCatalogDiscovery({
  deps,
  environment
}: StructuredAgentModelCatalogContext): AgentModelCatalogDiscovery {
  return {
    kind: 'probe',
    // Claude's settings or env can pick a model other than the one its listing recommends.
    listingNamesConfiguredModel: false,
    probe: createClaudeModelCatalogProbe({
      resolveInheritedEnv: environment.resolveBaseEnvironment,
      resolveAuthPolicy: deps.resolveClaudeAuthPolicy,
      ...(deps.resolveClaudeCommand ? { resolveCommand: deps.resolveClaudeCommand } : {}),
      ...claudeLaunchEnvOverlay(deps)
    })
  }
}

export function acpModelCatalogDiscovery(
  spec: AcpLaunchSpec,
  { deps, environment }: StructuredAgentModelCatalogContext
): AgentModelCatalogDiscovery {
  const discovery = spec.modelDiscovery
  if (discovery.kind === 'unavailable') {
    return { kind: 'unavailable', reason: discovery.reason }
  }
  return {
    kind: 'probe',
    listingNamesConfiguredModel: discovery.listingNamesConfiguredModel,
    probe: createAcpModelCatalogProbe(spec, {
      resolveEnvironment: environment.resolveBaseEnvironment,
      ...(deps.resolveAgentLaunchEnv ? { resolveLaunchEnv: deps.resolveAgentLaunchEnv } : {}),
      ...(deps.resolveAgentCommandSettings
        ? { resolveCommandSettings: deps.resolveAgentCommandSettings }
        : {})
    })
  }
}
