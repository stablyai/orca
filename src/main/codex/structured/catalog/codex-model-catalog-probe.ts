import { join, resolve as resolvePath } from 'node:path'
import {
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { agentModelCatalogInputStamp } from '../../../native-chat/agent-model-catalog/agent-model-catalog-input-stamp'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import { codexStructuredLaunchArgs } from '../launch/codex-structured-launch-args'
import { overlayEnvironmentVariables } from '../../../../shared/environment-overlay'
import {
  catalogListingDirectory,
  envWithPathRelativeTo
} from '../../../../shared/node-cli-command-resolution'
import type { AgentSessionAccountKind } from '../../../../shared/agent-session/agent-session-availability'
import { AgentModelCatalogUnavailableError } from '../../../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { isMissingProviderExecutable } from '../../../provider-process/provider-executable-missing'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../../../codex-cli/codex-read-only-app-server-args'
import { runCodexAppServerSession } from '../../app-server/codex-app-server-session'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import { codexProjectConfigIsolationArgs } from './codex-project-config-isolation'
import { applyCodexConfiguredLaunchDefaults } from '../launch/codex-configured-launch-defaults'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredInvocationDeps
} from '../launch/codex-structured-launch-resolution'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import type {
  AgentModelCatalogProgress,
  AgentModelCatalogProbe,
  AgentModelCatalogLookup
} from '../../../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import type { AgentModelCatalogSuccess } from '../../../native-chat/agent-model-catalog/agent-model-catalog-entry'

export type CodexModelCatalogProbeDeps = CodexStructuredInvocationDeps & {
  /** Saved preference reads must not attempt CLI recovery. */
  resolveSavedEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveEnv?: () => Record<string, string>
  resolveLaunchArgs?: () => Promise<string[]> | string[]
  resolveAccountKind?: (home: string) => AgentSessionAccountKind | undefined
  /** Match launch-time home sync so probes use the same login. */
  prepareHome?: (home: string) => void
  runSession?: typeof runCodexAppServerSession
}

function definedEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== undefined) {
      next[key] = value
    }
  }
  return next
}

// Share launch invocation resolution so probes list models with the session's binary, environment and account.
export function createCodexModelCatalogProbe(
  deps: CodexModelCatalogProbeDeps
): AgentModelCatalogProbe {
  const resolve = async (
    accountHome: Parameters<AgentModelCatalogProbe>[0],
    cwd?: string,
    lookup: AgentModelCatalogLookup = 'recover',
    operation?: StructuredAgentResolutionOperation,
    launchDirectory = cwd
  ) => {
    assertStructuredAgentResolutionCurrent(operation)
    const accountHomePath = requireLegacyAgentSessionAccountHome(accountHome).path
    const overlay = overlayEnvironmentVariables({}, deps.resolveEnv?.(), process.platform)
    const readEnvironment =
      lookup !== 'recover'
        ? (deps.resolveSavedEnvironment ?? deps.resolveEnvironment)
        : deps.resolveEnvironment
    const { command, prefixArgs, environment } = await resolveCodexStructuredInvocation({
      ...deps,
      operation,
      resolveEnvironment: async () =>
        overlayEnvironmentVariables((await readEnvironment?.()) ?? {}, overlay, process.platform),
      ...(lookup === 'recover' ? {} : { refreshEnvironmentAfterMiss: undefined }),
      ...(launchDirectory ? { resolveWorkingDirectory: () => launchDirectory } : {})
    })
    assertStructuredAgentResolutionCurrent(operation)
    const userArgs = [
      ...prefixArgs,
      ...(cwd ? codexStructuredLaunchArgs((await deps.resolveLaunchArgs?.()) ?? []) : [])
    ]
    // A command line that may name files relative to the chat's folder runs there, with that
    // folder untrusted so its project config never replaces the account's list. No root markers
    // keep Codex from reading a repo above the listing's folder, unless managed config sets its own.
    const listIn = catalogListingDirectory(command, userArgs, cwd, launchDirectory)
    const args = [
      ...userArgs,
      ...(listIn && listIn !== cwd ? await codexProjectConfigIsolationArgs(listIn) : []),
      '-c',
      'project_root_markers=[]',
      ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS
    ]
    assertStructuredAgentResolutionCurrent(operation)
    // The listing runs from the account folder; relative PATH entries still mean the chat's folder.
    const env = {
      ...(launchDirectory
        ? envWithPathRelativeTo(definedEnv(environment), launchDirectory)
        : definedEnv(environment)),
      CODEX_HOME: accountHomePath
    }
    return {
      inputStamp: await agentModelCatalogInputStamp({
        command,
        prefixArgs,
        cwd: listIn ?? process.cwd(),
        env: launchDirectory ? envWithPathRelativeTo(env, launchDirectory) : env,
        configFiles: [
          join(
            resolvePath(accountHomePath) === resolvePath(resolveOrcaManagedCodexHomePath())
              ? getSystemCodexHomePath()
              : accountHomePath,
            'config.toml'
          )
        ]
      }),
      identity: { command, args, cwd: listIn, overlay: Object.entries(overlay).sort() },
      run: async (
        signal?: AbortSignal,
        runOperation = operation,
        _selectedModels?: readonly string[],
        publish?: AgentModelCatalogProgress
      ): Promise<AgentModelCatalogSuccess> => {
        assertStructuredAgentResolutionCurrent(runOperation)
        signal?.throwIfAborted()
        deps.prepareHome?.(accountHomePath)
        const run = deps.runSession ?? runCodexAppServerSession
        const successFromListing = (
          listing: Awaited<ReturnType<typeof fetchCodexModelCatalogListing>>,
          unavailable: AgentModelCatalogSuccess['unavailable']
        ): AgentModelCatalogSuccess => {
          return {
            models: cwd
              ? listing.models
              : applyCodexConfiguredLaunchDefaults(listing.models, {
                  model: listing.configured?.model ?? null,
                  effort: listing.configured?.effort ?? null
                }),
            complete: listing.complete !== false,
            ...(cwd && listing.configured ? { configured: listing.configured } : {}),
            origin: 'probe',
            ...(unavailable ? { unavailable } : {})
          }
        }
        const { listing, unavailable } = await run(
          {
            command,
            args,
            ...(listIn ? { cwd: listIn } : {}),
            cliPath: command,
            env,
            timeoutMs: null,
            ...(signal ? { signal } : {})
          },
          async (rpc) => {
            let latest: Awaited<ReturnType<typeof fetchCodexModelCatalogListing>> | undefined
            let accountKnown = false
            let unavailable: AgentModelCatalogSuccess['unavailable']
            const observe = (next: NonNullable<typeof latest>) => {
              assertStructuredAgentResolutionCurrent(runOperation)
              latest = next
              publish?.(successFromListing(next, unavailable), accountKnown)
            }
            const account = rpc
              .request('account/read', { refreshToken: false }, { timeoutMs: null })
              .catch(() => undefined)
              .then((response: unknown) => {
                assertStructuredAgentResolutionCurrent(runOperation)
                if (
                  typeof response === 'object' &&
                  response !== null &&
                  !Array.isArray(response) &&
                  'account' in response
                ) {
                  accountKnown = true
                  if (
                    'requiresOpenaiAuth' in response &&
                    response.requiresOpenaiAuth === true &&
                    response.account === null
                  ) {
                    const kind = deps.resolveAccountKind?.(accountHomePath)
                    unavailable = { reason: 'notSignedIn', ...(kind ? { account: kind } : {}) }
                  }
                }
                if (latest) {
                  observe(latest)
                }
              })
            void account.catch(() => {})
            const listing = await fetchCodexModelCatalogListing({
              connection: rpc,
              cwd,
              operation: runOperation,
              timeoutMs: null,
              publish: observe
            }).catch(async (error: unknown) => {
              await account
              if (unavailable) {
                throw new AgentModelCatalogUnavailableError(unavailable)
              }
              throw error
            })
            observe(listing)
            await account
            return { listing, unavailable }
          }
        ).catch((error: unknown) => {
          if (isMissingProviderExecutable(error, command)) {
            throw new AgentModelCatalogUnavailableError({ reason: 'cliMissing' })
          }
          throw error
        })
        assertStructuredAgentResolutionCurrent(runOperation)
        if (listing.models.length === 0) {
          if (unavailable) {
            throw new AgentModelCatalogUnavailableError(unavailable)
          }
          throw new Error('codex app-server listed no models')
        }
        return successFromListing(listing, unavailable)
      }
    }
  }
  return Object.assign<
    AgentModelCatalogProbe,
    Pick<AgentModelCatalogProbe, 'resolve' | 'resolveLegacy'>
  >(
    async (home, options) =>
      (await resolve(home, options?.cwd ?? process.cwd(), 'recover', options?.operation)).run(
        options?.signal,
        options?.operation,
        options?.selectedModels,
        options?.publish
      ),
    {
      resolve,
      resolveLegacy: (home, operation, lookup) => resolve(home, undefined, lookup, operation)
    }
  )
}
