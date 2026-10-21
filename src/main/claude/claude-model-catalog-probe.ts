import {
  buildClaudeModelListArgs,
  CLAUDE_MODEL_LIST_STDIN,
  parseClaudeModelList
} from '../../shared/claude-model-list-probe'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { runClaudeBackgroundAttempts } from '../../shared/claude-background-run-isolation'
import { parseClaudeModels } from '../../shared/commit-message-model-parsers'
import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import {
  resolveClaudeStructuredInvocation,
  type ClaudeStructuredLaunchPartDeps
} from './claude-structured-launch-resolution'
import type { ClaudeEnvDeps } from './claude-structured-child-env'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import {
  AgentModelCatalogProbeError,
  runAgentModelCatalogListing
} from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'

export type ClaudeModelCatalogProbeDeps = ClaudeEnvDeps &
  Pick<ClaudeStructuredLaunchPartDeps, 'resolveAuthPolicy'> & {
    /** Test seam; production runs the shared supervised listing. */
    runListing?: typeof runAgentModelCatalogListing
  }

/** Asks Claude one control request without a session, under the SAME binary and environment the
 *  structured session launch resolves, pinned to the chat's account. */
export async function runClaudeListing(
  deps: ClaudeModelCatalogProbeDeps,
  request: {
    accountHomePath: string
    stdin: string
    site: string
    cwd?: string
    signal?: AbortSignal
    isCurrent?: () => boolean
  }
): Promise<string> {
  // Same pin rule as the session spawn: naming the CLI's default dir would move
  // it off the default Keychain item and list under another identity.
  const { command, env } = await resolveClaudeStructuredInvocation(deps, (base) => ({
    ...base,
    ...claudeConfigDirEnvPatch(request.accountHomePath, { env: base })
  }))
  const run = (args: readonly string[]) => {
    if (request.isCurrent && !request.isCurrent()) {
      throw new Error('Listing context retired')
    }
    return (deps.runListing ?? runAgentModelCatalogListing)(
      {
        command,
        args: [...args],
        stdin: request.stdin,
        ...(request.cwd ? { cwd: request.cwd } : {})
      },
      { site: request.site, inheritedEnv: env, signal: request.signal }
    )
  }
  const result = await runClaudeBackgroundAttempts({
    agentId: 'claude',
    run: (strictMcp) =>
      run(buildClaudeModelListArgs(strictMcp)).catch((error: unknown) => {
        if (error instanceof AgentModelCatalogProbeError) {
          return error
        }
        throw error
      }),
    failedExit: (outcome) =>
      outcome instanceof AgentModelCatalogProbeError && outcome.reason === 'exit'
        ? outcome.failedExit
        : undefined
  })
  if (result instanceof AgentModelCatalogProbeError) {
    throw result
  }
  return result
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
    const stdout = await runClaudeListing(deps, {
      accountHomePath: requireLegacyAgentSessionAccountHome(accountHome).path,
      stdin: CLAUDE_MODEL_LIST_STDIN,
      site: 'claude-model-catalog-probe',
      ...(options?.signal ? { signal: options.signal } : {})
    }).catch((error: unknown) => {
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
    // Only the catalog marks the CLI default; the commit-message parse keeps its own default.
    const runsDefault = new Set(
      parseClaudeModelList(stdout).flatMap((model) => (model.isDefault ? [model.id] : []))
    )
    return {
      models: listed.map((model) => ({
        id: model.id,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
        isDefault: runsDefault.has(model.id),
        // No defaultEffort: the parser's thinking default is the commit-message generator's
        // choice, not the effort Claude runs; the store keeps the one a live child reported.
        efforts: (model.thinkingLevels ?? []).map((level) => ({
          value: level.id,
          label: level.label
        })),
        ...(model.supportsFastMode !== undefined
          ? { supportsFastMode: model.supportsFastMode }
          : {}),
        ...(model.supportsAutoMode !== undefined
          ? { supportsAutoMode: model.supportsAutoMode }
          : {})
      })),
      origin: 'probe'
    }
  }
}
