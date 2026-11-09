import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../../../native-chat/structured-agent-command-resolution'
import { codexStructuredLaunchArgs } from '../launch/codex-structured-launch-args'
import { overlayEnvironmentVariables } from '../../../../shared/environment-overlay'
import { envWithPathRelativeTo } from '../../../../shared/node-cli-command-resolution'
import type { AgentSessionAccountKind } from '../../../../shared/agent-session/agent-session-availability'
import { AgentModelCatalogUnavailableError } from '../../../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { isMissingProviderExecutable } from '../../../provider-process/provider-executable-missing'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../../../codex-cli/codex-read-only-app-server-args'
import { runCodexAppServerSession } from '../../app-server/codex-app-server-session'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import { applyCodexConfiguredLaunchDefaults } from '../launch/codex-configured-launch-defaults'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredInvocationDeps
} from '../launch/codex-structured-launch-resolution'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/agent-session-account-home'
import { AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS } from '../../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type {
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
      lookup === 'saved' ? deps.resolveSavedEnvironment : deps.resolveEnvironment
    const { command, prefixArgs, environment } = await resolveCodexStructuredInvocation({
      ...deps,
      operation,
      resolveEnvironment: async () =>
        overlayEnvironmentVariables((await readEnvironment?.()) ?? {}, overlay, process.platform),
      ...(lookup === 'recover' ? {} : { refreshEnvironmentAfterMiss: undefined }),
      ...(launchDirectory ? { resolveWorkingDirectory: () => launchDirectory } : {})
    })
    assertStructuredAgentResolutionCurrent(operation)
    // Every listing runs in `cwd` with the user's command line, as other Codex hosts list from their
    // own folder, so the chat's repo never picks the list; relative paths in user arguments are not
    // resolved against the chat's folder. No root markers keep Codex from reading a repo above
    // Orca's folder too, unless an administrator's managed config sets its own.
    const args = [
      ...prefixArgs,
      ...(cwd ? codexStructuredLaunchArgs((await deps.resolveLaunchArgs?.()) ?? []) : []),
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
      identity: { command, args, cwd, overlay: Object.entries(overlay).sort() },
      run: async (
        signal?: AbortSignal,
        runOperation = operation
      ): Promise<AgentModelCatalogSuccess> => {
        assertStructuredAgentResolutionCurrent(runOperation)
        signal?.throwIfAborted()
        deps.prepareHome?.(accountHomePath)
        const run = deps.runSession ?? runCodexAppServerSession
        const { listing, unavailable } = await run(
          {
            command,
            args,
            ...(cwd ? { cwd } : {}),
            cliPath: command,
            env,
            timeoutMs: AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS,
            ...(signal ? { signal } : {})
          },
          async (rpc) => {
            assertStructuredAgentResolutionCurrent(runOperation)
            // Overlap model and account reads to avoid serial probe latency.
            const listed = fetchCodexModelCatalogListing({
              connection: rpc,
              cwd,
              operation: runOperation
            })
            void listed.catch(() => {})
            assertStructuredAgentResolutionCurrent(runOperation)
            const response: unknown = await rpc
              .request('account/read', { refreshToken: false }, { timeoutMs: 2_000 })
              // Failed account reads do not establish sign-out.
              .catch(() => undefined)
            assertStructuredAgentResolutionCurrent(runOperation)
            if (
              typeof response !== 'object' ||
              response === null ||
              Array.isArray(response) ||
              !('requiresOpenaiAuth' in response) ||
              response.requiresOpenaiAuth !== true ||
              !('account' in response) ||
              response.account !== null
            ) {
              return { listing: await listed, unavailable: undefined }
            }
            const account = deps.resolveAccountKind?.(accountHomePath)
            const signedOut = { reason: 'notSignedIn' as const, ...(account ? { account } : {}) }
            // Gateways may misreport sign-out; keep models that were successfully listed.
            const inHand = await listed.catch(() => null)
            assertStructuredAgentResolutionCurrent(runOperation)
            if (!inHand?.models.length) {
              throw new AgentModelCatalogUnavailableError(signedOut)
            }
            return { listing: inHand, unavailable: signedOut }
          }
        ).catch((error: unknown) => {
          if (isMissingProviderExecutable(error, command)) {
            throw new AgentModelCatalogUnavailableError({ reason: 'cliMissing' })
          }
          throw error
        })
        assertStructuredAgentResolutionCurrent(runOperation)
        if (listing.models.length === 0) {
          throw new Error('codex app-server listed no models')
        }
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
    }
  }
  return Object.assign<
    AgentModelCatalogProbe,
    Pick<AgentModelCatalogProbe, 'resolve' | 'resolveLegacy'>
  >(
    async (home, options) =>
      (await resolve(home, options?.cwd ?? process.cwd(), 'recover', options?.operation)).run(
        options?.signal
      ),
    { resolve, resolveLegacy: (home, operation) => resolve(home, undefined, 'recover', operation) }
  )
}
