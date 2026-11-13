// Use session launch resolvers, including missing-program env refresh, for probes so catalogs match the binary/account sessions actually use.

import { createAcpModelCatalogProbe } from '../../../acp/discovery/acp-model-catalog-probe'
import { acpListingNeedsChatFolder } from '../../../acp/discovery/acp-model-discovery-policy'
import type { AcpLaunchSpec } from '../../../acp/launch/acp-launch-contract'
import {
  createClaudeModelCatalogProbe,
  type ClaudeModelCatalogProbeDeps
} from '../../../claude/model-catalog/claude-model-catalog-probe'
import { createCodexModelCatalogProbe } from '../../../codex/structured/catalog/codex-model-catalog-probe'
import { createZcodeModelCatalogProbe } from '../../../zcode/structured/catalog/zcode-model-catalog-probe'
import { resolveZcodeChatCredentials } from '../../../zcode/structured/credentials/zcode-chat-credentials'
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
    ...(acpListingNeedsChatFolder(discovery) ? { listsInChatFolder: true as const } : {}),
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

export function zcodeModelCatalogDiscovery({
  deps,
  environment
}: StructuredAgentModelCatalogContext): AgentModelCatalogDiscovery {
  return {
    kind: 'probe',
    // The projection names the account's current model alongside the listing.
    listingNamesConfiguredModel: true,
    probe: createZcodeModelCatalogProbe({
      resolveEnvironment: environment.resolveBaseEnvironment,
      resolveCommandSettings: deps.resolveAgentCommandSettings,
      resolveLaunchArgs: () => deps.resolveLaunchArgs('zcode'),
      resolveChatCredentials: () =>
        resolveZcodeChatCredentials({ site: deps.resolveZcodeChatPlanSite?.() })
    })
  }
}
