import { join } from 'node:path'
import { agentModelCatalogInputStamp } from '../../native-chat/agent-model-catalog/agent-model-catalog-input-stamp'
import { withOrcaClaudeChatEntrypoint } from '../../../shared/agent-launch/startup/claude-chat-entrypoint'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../../native-chat/agent-launch/structured-agent-command-resolution'
import {
  buildClaudeModelListArgs,
  CLAUDE_MODEL_LIST_STDIN
} from '../../../shared/claude-model-list-probe'
import { requireLegacyAgentSessionAccountHome } from '../../../shared/agent-session/lifecycle/agent-session-account-home'
import { runClaudeBackgroundAttempts } from '../../../shared/claude-background-run-isolation'
import { listedModels, record } from '../structured/launch/claude-structured-model-catalog'
import { readClaudeCatalogObservation } from './claude-model-catalog-observation'
import { readClaudeControlResponses } from '../sdk-transport/claude-control-responses'
import { claudeStructuredLaunchArgs } from '../structured/launch/claude-structured-launch-args'
import { AgentModelCatalogUnavailableError } from '../../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { claudeConfigDirEnvPatch } from '../structured/launch/claude-config-dir-pin'
import {
  envWithPathRelativeTo,
  catalogListingDirectory
} from '../../../shared/node-cli-command-resolution'
import {
  CLAUDE_DEFAULT_SETTING_SOURCES,
  resolveClaudeStructuredInvocation,
  type ClaudeStructuredLaunchPartDeps
} from '../structured/launch/claude-structured-launch-resolution'
import {
  resolveClaudeChildEnvSources,
  type ClaudeEnvDeps
} from '../structured/launch/claude-structured-child-env'
import type {
  AgentModelCatalogProgress,
  AgentModelCatalogProbe,
  AgentModelCatalogLookup
} from '../../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import type { AgentModelCatalogSuccess } from '../../native-chat/agent-model-catalog/agent-model-catalog-entry'

import {
  AgentModelCatalogProbeError,
  runAgentModelCatalogListing
} from '../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'

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
      {
        site: request.site,
        inheritedEnv: withOrcaClaudeChatEntrypoint(env, process.platform),
        signal: request.signal
      }
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
    operation?: StructuredAgentResolutionOperation,
    launchDirectory = cwd
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
    const argsFor = (strictMcp: boolean, sources: readonly string[]) => [
      ...buildClaudeModelListArgs(strictMcp, userArgs),
      ...(cwd ? ['--setting-sources', sources.join(',')] : []),
      ...userArgs
    ]
    const launchDeps = {
      ...deps,
      operation,
      ...(lookup !== 'recover'
        ? { resolveInheritedEnv: deps.resolveSavedEnvironment ?? deps.resolveInheritedEnv }
        : {}),
      ...(lookup === 'recover' ? {} : { refreshEnvironmentAfterMiss: undefined }),
      ...(launchDirectory ? { resolveWorkingDirectory: () => launchDirectory } : {})
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
    // A command line that may name files relative to the chat's folder runs there, reading only
    // user settings so the project's settings never narrow the account's list.
    const listIn = catalogListingDirectory(
      command,
      [...prefixArgs, ...userArgs],
      cwd,
      launchDirectory
    )
    const settingSources = listIn === cwd ? CLAUDE_DEFAULT_SETTING_SOURCES : ['user']
    const args = argsFor(true, settingSources)
    return {
      inputStamp: await agentModelCatalogInputStamp({
        command,
        prefixArgs,
        cwd: listIn ?? process.cwd(),
        env: launchDirectory ? envWithPathRelativeTo(env, launchDirectory) : env,
        configFiles: [join(requireLegacyAgentSessionAccountHome(accountHome).path, 'settings.json')]
      }),
      identity: {
        command,
        prefixArgs,
        args,
        cwd: listIn,
        overlay: Object.entries(sources.overlay ?? {}).sort()
      },
      run: async (
        signal?: AbortSignal,
        runOperation = operation,
        _selectedModels?: readonly string[],
        publish?: AgentModelCatalogProgress
      ): Promise<AgentModelCatalogSuccess> => {
        assertStructuredAgentResolutionCurrent(runOperation)
        signal?.throwIfAborted()
        const outcome = await runClaudeBackgroundAttempts({
          agentId: 'claude',
          run: (strictMcp) => {
            assertStructuredAgentResolutionCurrent(runOperation)
            signal?.throwIfAborted()
            const requests = [
              'orca-model-discovery',
              'orca-model-settings',
              'orca-signin-discovery'
            ]
            const settled = new Set<string>()
            const replies = new Map<string, unknown>()
            let incomplete: string[] = []
            return (deps.runListing ?? runAgentModelCatalogListing)(
              {
                command,
                args: [...prefixArgs, ...argsFor(strictMcp, settingSources)],
                ...(listIn ? { cwd: listIn } : {}),
                stdin: `${CLAUDE_MODEL_LIST_STDIN}${JSON.stringify({ type: 'control_request', request_id: 'orca-model-settings', request: { subtype: 'get_settings' } })}\n${JSON.stringify({ type: 'control_request', request_id: 'orca-signin-discovery', request: { subtype: 'initialize' } })}\n`
              },
              {
                site: 'claude-model-catalog-probe',
                // The listing runs from the account folder; relative PATH entries still mean the chat's.
                inheritedEnv: withOrcaClaudeChatEntrypoint(
                  launchDirectory ? envWithPathRelativeTo(env, launchDirectory) : env,
                  process.platform
                ),
                signal,
                timeoutMs: null,
                onOutput: (chunk) => {
                  const lines = chunk.split('\n')
                  incomplete.push(lines[0])
                  if (lines.length === 1) {
                    return
                  }
                  const stdout = [incomplete.join(''), ...lines.slice(1, -1)].join('\n')
                  incomplete = [lines.at(-1)!]
                  const previous = settled.size
                  for (const [id, value] of readClaudeControlResponses(stdout, (id) => {
                    if (requests.includes(id)) {
                      settled.add(id)
                    }
                  })) {
                    if (requests.includes(id)) {
                      replies.set(id, value)
                    }
                  }
                  if (
                    settled.size > previous &&
                    listedModels(replies.get('orca-model-discovery')).length > 0
                  ) {
                    publish?.(
                      readClaudeCatalogObservation(replies, env, account),
                      record(record(replies.get('orca-signin-discovery'))?.account) !== null &&
                        record(record(replies.get('orca-model-settings'))?.effective) !== null
                    )
                  }
                },
                completeOutput: () => requests.every((id) => settled.has(id))
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
        return readClaudeCatalogObservation(readClaudeControlResponses(outcome), env, account)
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
      ).run(options?.signal, options?.operation, options?.selectedModels, options?.publish),
    {
      resolve,
      resolveLegacy: (home, operation, lookup) => resolve(home, undefined, lookup, operation)
    }
  )
}
