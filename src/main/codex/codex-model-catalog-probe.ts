import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../native-chat/structured-agent-command-resolution'
import { codexStructuredLaunchArgs } from './codex-structured-launch-args'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { isMissingProviderExecutable } from '../provider-process/provider-executable-missing'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { runCodexAppServerSession } from './codex-app-server-session'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import { applyCodexConfiguredLaunchDefaults } from './codex-configured-launch-defaults'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredInvocationDeps
} from './codex-structured-launch-resolution'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { AgentModelCatalogLookup } from '../native-chat/agent-model-catalog/agent-model-catalog-discovery'

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
    operation?: StructuredAgentResolutionOperation
  ) => {
    assertStructuredAgentResolutionCurrent(operation)
    const accountHomePath = requireLegacyAgentSessionAccountHome(accountHome).path
    const overlay = { ...deps.resolveEnv?.() }
    const readEnvironment =
      lookup === 'saved' ? deps.resolveSavedEnvironment : deps.resolveEnvironment
    const { command, prefixArgs, environment } = await resolveCodexStructuredInvocation({
      ...deps,
      operation,
      resolveEnvironment: async () => ({ ...(await readEnvironment?.()), ...overlay }),
      ...(lookup === 'recover' ? {} : { refreshEnvironmentAfterMiss: undefined }),
      ...(cwd ? { resolveWorkingDirectory: () => cwd } : {})
    })
    assertStructuredAgentResolutionCurrent(operation)
    const args = [
      ...prefixArgs,
      ...(cwd ? codexStructuredLaunchArgs((await deps.resolveLaunchArgs?.()) ?? []) : []),
      ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS
    ]
    assertStructuredAgentResolutionCurrent(operation)
    const env = { ...definedEnv(environment), CODEX_HOME: accountHomePath }
    return {
      identity: { command, args, cwd, overlay: Object.entries(overlay).sort() },
      run: async (signal?: AbortSignal): Promise<AgentModelCatalogSuccess> => {
        assertStructuredAgentResolutionCurrent(operation)
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
            assertStructuredAgentResolutionCurrent(operation)
            // Overlap model and account reads to avoid serial probe latency.
            const listed = fetchCodexModelCatalogListing({ connection: rpc, cwd, operation })
            void listed.catch(() => {})
            assertStructuredAgentResolutionCurrent(operation)
            const response: unknown = await rpc
              .request('account/read', { refreshToken: false }, { timeoutMs: 2_000 })
              // Failed account reads do not establish sign-out.
              .catch(() => undefined)
            assertStructuredAgentResolutionCurrent(operation)
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
            assertStructuredAgentResolutionCurrent(operation)
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
        assertStructuredAgentResolutionCurrent(operation)
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
