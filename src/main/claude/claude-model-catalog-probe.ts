import { discoverModelsLocal } from '../text-generation/commit-message-model-discovery'
import { commandBackslashMode } from '../text-generation/commit-message-text-generation'
import { spawnSourceControlAgent } from '../text-generation/source-control-agent-launch'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import {
  resolveClaudeStructuredInvocation,
  type ClaudeStructuredLaunchResolverDeps
} from './claude-structured-launch-resolution'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'

export type ClaudeModelCatalogProbeDeps = Pick<
  ClaudeStructuredLaunchResolverDeps,
  'resolveCommand' | 'resolveEnv' | 'resolveInheritedEnv' | 'resolveAuthPolicy'
> & {
  authSwitchSettleTimeoutMs?: number
  /** Test seams; production runs the one-shot listing child. */
  discover?: typeof discoverModelsLocal
  spawnAgent?: typeof spawnSourceControlAgent
}

/**
 * Lists models without a live session, through the existing one-shot CLI
 * listing — but under the SAME binary and environment the structured session
 * launch resolves, so a probe can never list under a different install or
 * shell env than the sessions it stands in for.
 */
export function createClaudeModelCatalogProbe(
  deps: ClaudeModelCatalogProbeDeps
): AgentModelCatalogProbe {
  return async (accountHomePath: string): Promise<AgentModelCatalogSuccess> => {
    // Same pin rule as the session spawn: naming the CLI's default dir would move
    // it off the default Keychain item and list under another identity.
    const { command, env } = await resolveClaudeStructuredInvocation(deps, (base) => ({
      ...base,
      ...claudeConfigDirEnvPatch(accountHomePath, { env: base })
    }))
    const result = await (deps.discover ?? discoverModelsLocal)({
      agentId: 'claude',
      env,
      options: {},
      backslash: commandBackslashMode({ kind: 'local', cwd: '' }),
      // The resolved absolute command replaces the plan's bare binary directly:
      // routing it through the command-override template would re-tokenize a
      // path that may contain spaces.
      spawnAgent: (input) =>
        (deps.spawnAgent ?? spawnSourceControlAgent)({ ...input, binary: command })
    })
    // The spec's static fallback must never pass as a listing: Claude's real
    // list replaces the seed, so only a probe-origin answer is a catalog.
    if (!result.success || result.catalogOrigin !== 'probe' || result.models.length === 0) {
      throw new Error(result.success ? 'claude listed no models' : result.error)
    }
    return {
      models: result.models.map((model) => ({
        id: model.id,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
        isDefault: model.isDefault === true,
        // No defaultEffort: the listing's thinking default is the commit-message generator's
        // choice, not the effort Claude runs, and a live session's listing never names one.
        efforts: (model.thinkingLevels ?? []).map((level) => ({
          value: level.id,
          label: level.label
        })),
        ...(model.supportsFastMode !== undefined
          ? { supportsFastMode: model.supportsFastMode }
          : {})
      })),
      fastModeTierByModel: new Map(),
      origin: 'probe'
    }
  }
}
