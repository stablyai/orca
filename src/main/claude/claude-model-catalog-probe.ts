import {
  CLAUDE_MODEL_LIST_ARGS,
  CLAUDE_MODEL_LIST_STDIN
} from '../../shared/claude-model-list-probe'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { parseClaudeModels } from '../../shared/commit-message-model-parsers'
import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import {
  resolveClaudeStructuredInvocation,
  type ClaudeStructuredLaunchResolverDeps
} from './claude-structured-launch-resolution'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  AgentModelCatalogProbeError,
  runAgentModelCatalogListing
} from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'

export type ClaudeModelCatalogProbeDeps = Pick<
  ClaudeStructuredLaunchResolverDeps,
  'resolveCommand' | 'resolveEnv' | 'resolveInheritedEnv' | 'resolveAuthPolicy'
> & {
  /** Test seam; production runs the shared supervised listing. */
  runListing?: typeof runAgentModelCatalogListing
}

/**
 * Lists models without a live session: one `list_models` control request, under the SAME binary
 * and environment the structured session launch resolves, so a probe can never list under a
 * different install or shell env than the sessions it stands in for.
 */
export function createClaudeModelCatalogProbe(
  deps: ClaudeModelCatalogProbeDeps
): AgentModelCatalogProbe {
  return async (accountHome, options): Promise<AgentModelCatalogSuccess> => {
    const accountHomePath = requireLegacyAgentSessionAccountHome(accountHome).path
    // Same pin rule as the session spawn: naming the CLI's default dir would move
    // it off the default Keychain item and list under another identity.
    const { command, env } = await resolveClaudeStructuredInvocation(deps, (base) => ({
      ...base,
      ...claudeConfigDirEnvPatch(accountHomePath, { env: base })
    }))
    const stdout = await (deps.runListing ?? runAgentModelCatalogListing)(
      { command, args: [...CLAUDE_MODEL_LIST_ARGS], stdin: CLAUDE_MODEL_LIST_STDIN },
      { site: 'claude-model-catalog-probe', inheritedEnv: env, signal: options?.signal }
    ).catch((error: unknown) => {
      // Claude has no pre-send sign-in verdict; a missing CLI is the one this probe can find.
      if (error instanceof AgentModelCatalogProbeError && error.executableMissing) {
        throw new AgentModelCatalogUnavailableError({ reason: 'cliMissing' })
      }
      throw error
    })
    // A CLI that predates the request answers a control error: no models, so no catalog.
    const listed = parseClaudeModels(stdout)
    if (listed.length === 0) {
      throw new Error('claude listed no models')
    }
    return {
      models: listed.map((model) => ({
        id: model.id,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
        isDefault: model.isDefault === true,
        // No defaultEffort: the parser's thinking default is the commit-message generator's
        // choice, not the effort Claude runs; the store keeps the one a live child reported.
        efforts: (model.thinkingLevels ?? []).map((level) => ({
          value: level.id,
          label: level.label
        })),
        ...(model.supportsFastMode !== undefined
          ? { supportsFastMode: model.supportsFastMode }
          : {})
      })),
      origin: 'probe'
    }
  }
}
