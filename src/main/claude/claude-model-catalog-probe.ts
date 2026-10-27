import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  buildClaudeModelListArgs,
  CLAUDE_MODEL_LIST_STDIN
} from '../../shared/claude-model-list-probe'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { runClaudeBackgroundAttempts } from '../../shared/claude-background-run-isolation'
import {
  isCompleteClaudeModelListing,
  listedModels,
  record,
  type ListedModel
} from './claude-structured-model-catalog'
import { claudeFastModeSupport, wireClaudeModels } from './claude-structured-catalog-listing'
import { readClaudeSettingsApplied } from './claude-structured-session-options'
import { claudeStructuredLaunchArgs } from './claude-structured-launch-args'
import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import {
  CLAUDE_DEFAULT_SETTING_SOURCES,
  resolveClaudeStructuredInvocation,
  type ClaudeStructuredLaunchPartDeps
} from './claude-structured-launch-resolution'
import { resolveClaudeChildEnvSources, type ClaudeEnvDeps } from './claude-structured-child-env'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentModelCatalogLookup } from '../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import {
  AgentModelCatalogProbeError,
  runAgentModelCatalogListing
} from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'

export type ClaudeModelCatalogProbeDeps = ClaudeEnvDeps &
  Pick<ClaudeStructuredLaunchPartDeps, 'resolveAuthPolicy'> & {
    /** Existing captured environment only: saved preference reads never recover a missing CLI. */
    resolveSavedEnvironment?: () => Promise<Record<string, string>>
    resolveLaunchArgs?: () => Promise<string[]> | string[]
    /** Test seam; production runs the shared supervised listing. */
    runListing?: typeof runAgentModelCatalogListing
  }

// Use the session's binary, environment and account for one-shot control requests.
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
  // Explicitly pinning the default directory changes the CLI's Keychain identity.
  const { command, env } = await waitForPromiseWithSignal(
    resolveClaudeStructuredInvocation({ ...deps, signal: request.signal }, (base) => ({
      ...base,
      ...claudeConfigDirEnvPatch(request.accountHomePath, { env: base })
    })),
    request.signal
  )
  const run = (args: readonly string[]) => {
    request.signal?.throwIfAborted()
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

// List models and settings with the same resolved executable, environment and account as sessions.
export function createClaudeModelCatalogProbe(
  deps: ClaudeModelCatalogProbeDeps
): AgentModelCatalogProbe {
  const resolve = async (
    accountHome: Parameters<AgentModelCatalogProbe>[0],
    cwd?: string,
    lookup: AgentModelCatalogLookup = 'recover'
  ) => {
    const configuredArgs = claudeStructuredLaunchArgs(
      cwd ? ((await deps.resolveLaunchArgs?.()) ?? []) : []
    )
    const userArgs = [
      ...Object.entries(configuredArgs.extraArgs).flatMap(([key, value]) =>
        value === null ? [`--${key}`] : [`--${key}`, value]
      ),
      ...configuredArgs.additionalDirectories.flatMap((directory) => ['--add-dir', directory])
    ]
    const argsFor = (strictMcp: boolean) => [
      ...buildClaudeModelListArgs(strictMcp, userArgs),
      ...(cwd ? ['--setting-sources', CLAUDE_DEFAULT_SETTING_SOURCES.join(',')] : []),
      ...userArgs
    ]
    const args = argsFor(true)
    const launchDeps = {
      ...deps,
      ...(lookup === 'saved' ? { resolveInheritedEnv: deps.resolveSavedEnvironment } : {}),
      ...(lookup === 'recover' ? {} : { refreshEnvironmentAfterMiss: undefined }),
      ...(cwd ? { resolveWorkingDirectory: () => cwd } : {})
    }
    const sources = await resolveClaudeChildEnvSources(launchDeps)
    const { command, env } = await resolveClaudeStructuredInvocation(
      launchDeps,
      (base) => ({
        ...base,
        ...claudeConfigDirEnvPatch(requireLegacyAgentSessionAccountHome(accountHome).path, {
          env: base
        })
      }),
      sources
    )
    return {
      identity: { command, args, cwd, overlay: Object.entries(sources.overlay ?? {}).sort() },
      run: async (signal?: AbortSignal): Promise<AgentModelCatalogSuccess> => {
        const outcome = await runClaudeBackgroundAttempts({
          agentId: 'claude',
          run: (strictMcp) =>
            (deps.runListing ?? runAgentModelCatalogListing)(
              {
                command,
                args: argsFor(strictMcp),
                ...(cwd ? { cwd } : {}),
                stdin: `${CLAUDE_MODEL_LIST_STDIN}${JSON.stringify({ type: 'control_request', request_id: 'orca-model-settings', request: { subtype: 'get_settings' } })}\n`
              },
              { site: 'claude-model-catalog-probe', inheritedEnv: env, signal }
            ).catch((error: unknown) => {
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
        if (outcome instanceof AgentModelCatalogProbeError) {
          if (outcome.executableMissing) {
            throw new AgentModelCatalogUnavailableError({ reason: 'cliMissing' })
          }
          throw outcome
        }
        const stdout = outcome
        let models: ListedModel[] = []
        let complete = false
        let configured: AgentModelCatalogSuccess['configured']
        for (const line of stdout.split(/\r?\n/)) {
          try {
            const response = record(record(JSON.parse(line))?.response)
            if (response?.subtype !== 'success') {
              continue
            }
            const body = response.response
            const listed = response.request_id === 'orca-model-discovery' ? listedModels(body) : []
            if (listed.length > 0) {
              models = listed
              complete = isCompleteClaudeModelListing(body)
            }
            if (response.request_id === 'orca-model-settings') {
              const applied = record(record(body)?.applied)
              if (
                applied &&
                !Array.isArray(applied) &&
                ['model', 'effort'].every(
                  (key) => applied[key] == null || typeof applied[key] === 'string'
                )
              ) {
                configured = readClaudeSettingsApplied(body) ?? undefined
              }
            }
          } catch {
            /* Non-JSON diagnostic output carries no catalog facts. */
          }
        }
        if (models.length === 0) {
          throw new Error('claude listed no models')
        }
        const fastModeSupport = claudeFastModeSupport(models, undefined)
        return {
          models: wireClaudeModels(models),
          origin: 'probe',
          complete: complete && configured !== undefined,
          ...(fastModeSupport ? { fastModeSupport } : {}),
          ...(configured ? { configured } : {})
        }
      }
    }
  }
  return Object.assign<
    AgentModelCatalogProbe,
    Pick<AgentModelCatalogProbe, 'resolve' | 'resolveLegacy'>
  >(
    async (home, options) =>
      (await resolve(home, options?.cwd ?? options?.workspacePath ?? process.cwd())).run(
        options?.signal
      ),
    { resolve, resolveLegacy: (home) => resolve(home) }
  )
}
