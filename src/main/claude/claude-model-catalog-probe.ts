import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../native-chat/structured-agent-command-resolution'
import {
  buildClaudeModelListArgs,
  CLAUDE_MODEL_LIST_STDIN
} from '../../shared/claude-model-list-probe'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session/lifecycle/agent-session-account-home'
import { runClaudeBackgroundAttempts } from '../../shared/claude-background-run-isolation'
import {
  isCompleteClaudeModelListing,
  listedModels,
  record
} from './structured/launch/claude-structured-model-catalog'
import {
  claudeFastModeSupport,
  wireClaudeModels
} from './structured/launch/claude-structured-catalog-listing'
import { readClaudeSettingsApplied } from './structured/launch/claude-structured-session-options'
import { readClaudeControlResponses } from './claude-control-responses'
import { claudeStructuredLaunchArgs } from './structured/launch/claude-structured-launch-args'
import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import {
  CLAUDE_DEFAULT_SETTING_SOURCES,
  resolveClaudeStructuredInvocation,
  type ClaudeStructuredLaunchPartDeps
} from './structured/launch/claude-structured-launch-resolution'
import {
  resolveClaudeChildEnvSources,
  type ClaudeEnvDeps
} from './structured/launch/claude-structured-child-env'
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
  const { command, prefixArgs, env } = await waitForPromiseWithSignal(
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
        args: [...prefixArgs, ...args],
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
    lookup: AgentModelCatalogLookup = 'recover',
    operation?: StructuredAgentResolutionOperation
  ) => {
    assertStructuredAgentResolutionCurrent(operation)
    const configuredArgs = claudeStructuredLaunchArgs(
      cwd ? ((await deps.resolveLaunchArgs?.()) ?? []) : []
    )
    assertStructuredAgentResolutionCurrent(operation)
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
      operation,
      ...(lookup === 'saved' ? { resolveInheritedEnv: deps.resolveSavedEnvironment } : {}),
      ...(lookup === 'recover' ? {} : { refreshEnvironmentAfterMiss: undefined }),
      ...(cwd ? { resolveWorkingDirectory: () => cwd } : {})
    }
    const sources = await resolveClaudeChildEnvSources(launchDeps)
    assertStructuredAgentResolutionCurrent(operation)
    const { command, prefixArgs, env, account } = await resolveClaudeStructuredInvocation(
      launchDeps,
      (base) => ({
        ...base,
        ...claudeConfigDirEnvPatch(requireLegacyAgentSessionAccountHome(accountHome).path, {
          env: base
        })
      }),
      sources
    )
    assertStructuredAgentResolutionCurrent(operation)
    return {
      identity: {
        command,
        prefixArgs,
        args,
        cwd,
        overlay: Object.entries(sources.overlay ?? {}).sort()
      },
      run: async (signal?: AbortSignal): Promise<AgentModelCatalogSuccess> => {
        assertStructuredAgentResolutionCurrent(operation)
        signal?.throwIfAborted()
        const outcome = await runClaudeBackgroundAttempts({
          agentId: 'claude',
          run: (strictMcp) => {
            assertStructuredAgentResolutionCurrent(operation)
            signal?.throwIfAborted()
            return (deps.runListing ?? runAgentModelCatalogListing)(
              {
                command,
                args: [...prefixArgs, ...argsFor(strictMcp)],
                ...(cwd ? { cwd } : {}),
                stdin: `${CLAUDE_MODEL_LIST_STDIN}${JSON.stringify({ type: 'control_request', request_id: 'orca-model-settings', request: { subtype: 'get_settings' } })}\n${JSON.stringify({ type: 'control_request', request_id: 'orca-signin-discovery', request: { subtype: 'initialize' } })}\n`
              },
              {
                site: 'claude-model-catalog-probe',
                inheritedEnv: env,
                signal,
                partialOutput: {
                  timeoutMs: 2_000,
                  ready: (stdout) => {
                    const replies = readClaudeControlResponses(stdout)
                    return (
                      listedModels(replies.get('orca-model-discovery')).length > 0 &&
                      replies.has('orca-model-settings')
                    )
                  }
                }
              }
            ).catch((error: unknown) => {
              if (error instanceof AgentModelCatalogProbeError) {
                return error
              }
              throw error
            })
          },
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
        const replies = readClaudeControlResponses(stdout)
        const listing = replies.get('orca-model-discovery')
        const models = listedModels(listing)
        const settings = replies.get('orca-model-settings')
        const applied = record(record(settings)?.applied)
        const configured =
          applied &&
          ['model', 'effort'].every(
            (key) => applied[key] == null || typeof applied[key] === 'string'
          )
            ? (readClaudeSettingsApplied(settings) ?? undefined)
            : undefined
        if (models.length === 0) {
          throw new Error('claude listed no models')
        }
        const fastModeSupport = claudeFastModeSupport(models, undefined)
        return {
          models: wireClaudeModels(models),
          origin: 'probe',
          complete: isCompleteClaudeModelListing(listing) && configured !== undefined,
          ...(fastModeSupport ? { fastModeSupport } : {}),
          ...(configured ? { configured } : {}),
          ...(claudeCatalogSignedOut(replies.get('orca-signin-discovery'), settings, env)
            ? { unavailable: { reason: 'notSignedIn', account } }
            : {})
        }
      }
    }
  }
  return Object.assign<
    AgentModelCatalogProbe,
    Pick<AgentModelCatalogProbe, 'resolve' | 'resolveLegacy'>
  >(
    async (home, options) =>
      (
        await resolve(
          home,
          options?.cwd ?? options?.workspacePath ?? process.cwd(),
          'recover',
          options?.operation
        )
      ).run(options?.signal),
    { resolve, resolveLegacy: (home, operation) => resolve(home, undefined, 'recover', operation) }
  )
}

function claudeCatalogSignedOut(
  initialization: unknown,
  settings: unknown,
  env: Readonly<Record<string, string>>
): boolean {
  const account = record(record(initialization)?.account)
  const effective = record(record(settings)?.effective)
  if (
    !account ||
    !effective ||
    account.tokenSource !== 'none' ||
    (account.apiProvider !== undefined && account.apiProvider !== 'firstParty') ||
    (account.apiKeySource && account.apiKeySource !== 'none') ||
    account.email ||
    account.subscriptionType
  ) {
    return false
  }
  const configuredEnv = record(effective.env)
  const endpoint = configuredEnv?.ANTHROPIC_BASE_URL ?? env.ANTHROPIC_BASE_URL
  if (typeof endpoint === 'string' && endpoint.trim()) {
    try {
      const url = new URL(endpoint)
      return url.protocol === 'https:' && url.hostname === 'api.anthropic.com'
    } catch {
      return false
    }
  }
  return true
}
