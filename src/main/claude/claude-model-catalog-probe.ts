import {
  CLAUDE_MODEL_LIST_ARGS,
  CLAUDE_MODEL_LIST_STDIN
} from '../../shared/claude-model-list-probe'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import {
  isCompleteClaudeModelListing,
  listedModels,
  record
} from './claude-structured-model-catalog'
import { wireClaudeModels } from './claude-structured-catalog-listing'
import { readClaudeSettingsApplied } from './claude-structured-session-options'
import { claudeStructuredLaunchArgs } from './claude-structured-launch-args'
import { claudeStructuredSpawnOptions } from './claude-structured-spawn-options'
import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import {
  CLAUDE_DEFAULT_SETTING_SOURCES,
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
    resolveLaunchArgs?: () => Promise<string[]> | string[]
    runListing?: typeof runAgentModelCatalogListing
  }

/** Asks Claude one control request without a session, under the SAME binary and environment the
 *  structured session launch resolves, pinned to the chat's account. */
export async function runClaudeListing(
  deps: ClaudeModelCatalogProbeDeps,
  request: {
    accountHomePath: string
    args: readonly string[]
    stdin: string
    site: string
    cwd?: string
    signal?: AbortSignal
  }
): Promise<string> {
  // Same pin rule as the session spawn: naming the CLI's default dir would move
  // it off the default Keychain item and list under another identity.
  const { command, env } = await resolveClaudeStructuredInvocation(deps, (base) => ({
    ...base,
    ...claudeConfigDirEnvPatch(request.accountHomePath, { env: base })
  }))
  return (deps.runListing ?? runAgentModelCatalogListing)(
    {
      command,
      args: [...request.args],
      stdin: request.stdin,
      ...(request.cwd ? { cwd: request.cwd } : {})
    },
    { site: request.site, inheritedEnv: env, signal: request.signal }
  )
}

/**
 * Lists models without a live session: one `list_models` control request, under the SAME binary
 * and environment the structured session launch resolves, so a probe can never list under a
 * different install or shell env than the sessions it stands in for.
 */
export function createClaudeModelCatalogProbe(
  deps: ClaudeModelCatalogProbeDeps
): AgentModelCatalogProbe {
  const resolve: NonNullable<AgentModelCatalogProbe['resolve']> = async (
    accountHome,
    cwd,
    saved
  ) => {
    const configuredArgs = claudeStructuredLaunchArgs((await deps.resolveLaunchArgs?.()) ?? [])
    const { sdkOptions } = claudeStructuredSpawnOptions({
      launch: { options: configuredArgs, resumesTranscript: false },
      saved
    })
    const effectiveArgs = {
      ...sdkOptions.extraArgs,
      ...(sdkOptions.model !== undefined ? { model: sdkOptions.model } : {}),
      ...(sdkOptions.effort !== undefined ? { effort: sdkOptions.effort } : {}),
      ...(sdkOptions.settings ? { settings: JSON.stringify(sdkOptions.settings) } : {})
    }
    const args = [
      ...CLAUDE_MODEL_LIST_ARGS,
      '--setting-sources',
      CLAUDE_DEFAULT_SETTING_SOURCES.join(','),
      ...Object.entries(effectiveArgs).flatMap(([key, value]) =>
        value === null ? [`--${key}`] : [`--${key}`, value]
      ),
      ...configuredArgs.additionalDirectories.flatMap((directory) => ['--add-dir', directory])
    ]
    const { command, env } = await resolveClaudeStructuredInvocation(
      { ...deps, resolveWorkingDirectory: () => cwd },
      (base) => ({
        ...base,
        ...claudeConfigDirEnvPatch(requireLegacyAgentSessionAccountHome(accountHome).path, {
          env: base
        })
      })
    )
    const launch = { command, args, cwd, env }
    return {
      identity: launch,
      run: async (signal): Promise<AgentModelCatalogSuccess> => {
        const stdout = await (deps.runListing ?? runAgentModelCatalogListing)(
          {
            command,
            args,
            cwd,
            stdin: `${
              CLAUDE_MODEL_LIST_STDIN +
              JSON.stringify({
                type: 'control_request',
                request_id: 'orca-model-settings',
                request: { subtype: 'get_settings' }
              })
            }\n`
          },
          { site: 'claude-model-catalog-probe', inheritedEnv: env, signal }
        ).catch((error: unknown) => {
          if (error instanceof AgentModelCatalogProbeError && error.executableMissing) {
            throw new AgentModelCatalogUnavailableError({ reason: 'cliMissing' })
          }
          throw error
        })
        let models: AgentModelCatalogSuccess['models'] = []
        let complete = false
        let configured: AgentModelCatalogSuccess['configured']
        for (const line of stdout.split(/\r?\n/)) {
          try {
            const response = record(record(JSON.parse(line))?.response)
            if (response?.subtype !== 'success') {
              continue
            }
            const body = response.response
            const listed = listedModels(body)
            if (listed.length > 0) {
              models = wireClaudeModels(listed)
              complete = isCompleteClaudeModelListing(body)
            }
            configured = readClaudeSettingsApplied(body) ?? configured
          } catch {
            /* Non-JSON diagnostic output carries no catalog facts. */
          }
        }
        if (models.length === 0) {
          throw new Error('claude listed no models')
        }
        return {
          models,
          origin: 'probe',
          complete: complete && !Object.hasOwn(effectiveArgs, 'model'),
          ...(configured ? { configured } : {})
        }
      }
    }
  }
  return Object.assign<AgentModelCatalogProbe, Pick<AgentModelCatalogProbe, 'resolve'>>(
    async (home, options) =>
      (await resolve(home, options?.cwd ?? process.cwd())).run(options?.signal),
    { resolve }
  )
}
