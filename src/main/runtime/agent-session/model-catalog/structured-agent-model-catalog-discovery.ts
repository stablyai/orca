// Use session launch resolvers, including missing-program env refresh, for probes so catalogs match the binary/account sessions actually use.

import { createAcpModelCatalogProbe } from '../../../acp/discovery/acp-model-catalog-probe'
import {
  acpAgentModelDiscoveries,
  acpListingNeedsChatFolder
} from '../../../acp/discovery/acp-model-discovery-policy'
import type { AcpLaunchSpec } from '../../../acp/launch/acp-launch-contract'
import {
  createClaudeModelCatalogProbe,
  type ClaudeModelCatalogProbeDeps
} from '../../../claude/claude-model-catalog-probe'
import { createCodexModelCatalogProbe } from '../../../codex/structured/catalog/codex-model-catalog-probe'
import type { AgentModelCatalogDiscovery } from '../../../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import type { StructuredAgentModelCatalogContext } from '../installation/structured-agent-runtime-registration-types'
import type { StructuredAgentSessionRuntimeDeps } from '../installation/structured-agent-session-runtime-contract'

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
      ...(deps.runCodexCatalogSession ? { runSession: deps.runCodexCatalogSession } : {}),
      resolveLaunchArgs: () => deps.resolveLaunchArgs('codex'),
      ...(deps.prepareCodexCatalogProbeHome
        ? { prepareHome: deps.prepareCodexCatalogProbeHome }
        : {}),
      resolveEnvironment: environment.resolveBaseEnvironment,
      resolveSavedEnvironment: () => environment.resolveBaseEnvironment(true),
      resolveEnv: () => deps.resolveAgentLaunchEnv?.('codex') ?? {},
      refreshEnvironmentAfterMiss: environment.refreshAfterMissingProgram,
      ...(deps.resolveCodexCommand ? { resolveCommand: deps.resolveCodexCommand } : {})
    })
  }
}

/** What every sessionless Claude listing (models, `/` commands) resolves its binary and env from. */
export function claudeListingDeps({
  deps,
  environment
}: StructuredAgentModelCatalogContext): ClaudeModelCatalogProbeDeps {
  return {
    resolveInheritedEnv: environment.resolveBaseEnvironment,
    resolveSavedEnvironment: () => environment.resolveBaseEnvironment(true),
    refreshEnvironmentAfterMiss: environment.refreshAfterMissingProgram,
    resolveAuthPolicy: deps.resolveClaudeAuthPolicy,
    ...(deps.resolveClaudeCommand ? { resolveCommand: deps.resolveClaudeCommand } : {}),
    ...claudeLaunchEnvOverlay(deps)
  }
}

export function claudeModelCatalogDiscovery(
  context: StructuredAgentModelCatalogContext
): AgentModelCatalogDiscovery {
  return {
    kind: 'probe',
    // Claude's settings or env can pick a model other than the one its listing recommends.
    listingNamesConfiguredModel: false,
    probe: createClaudeModelCatalogProbe({
      ...claudeListingDeps(context),
      resolveLaunchArgs: () => context.deps.resolveLaunchArgs('claude')
    })
  }
}

/** Build model-catalog discovery for `spec`, falling back to `hostBackend` discovery when managed discovery is unavailable. */
export function acpModelCatalogDiscovery(
  spec: AcpLaunchSpec,
  { deps, environment }: StructuredAgentModelCatalogContext
): AgentModelCatalogDiscovery {
  if (
    spec.modelDiscovery.kind === 'unavailable' &&
    (!spec.hostBackend || spec.hostBackend.spec.modelDiscovery.kind === 'unavailable')
  ) {
    return { kind: 'unavailable', reason: spec.modelDiscovery.reason }
  }
  const supported = acpAgentModelDiscoveries(spec).filter((entry) => entry.kind !== 'unavailable')
  return {
    kind: 'probe',
    listingNamesConfiguredModel: supported.every((entry) => entry.listingNamesConfiguredModel),
    ...(supported.some(acpListingNeedsChatFolder) ? { listsInChatFolder: true } : {}),
    probe: createAcpModelCatalogProbe(spec, {
      resolveEnvironment: environment.resolveBaseEnvironment,
      refreshEnvironmentAfterMiss: environment.refreshAfterMissingProgram,
      dataDirectory: deps.stateDirectory,
      ...(deps.resolveAgentLaunchEnv ? { resolveLaunchEnv: deps.resolveAgentLaunchEnv } : {}),
      ...(deps.resolveAgentCommandSettings
        ? { resolveCommandSettings: deps.resolveAgentCommandSettings }
        : {})
    })
  }
}
