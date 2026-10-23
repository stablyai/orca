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
  /** Existing captured environment only: saved preference reads never recover a missing CLI. */
  resolveSavedEnvironment?: () => Promise<NodeJS.ProcessEnv>
  resolveEnv?: () => Record<string, string>
  resolveLaunchArgs?: () => Promise<string[]> | string[]
  resolveAccountKind?: (home: string) => AgentSessionAccountKind | undefined
  /** The sync a launch runs on this home first, so the probe reads the login a launch would. */
  prepareHome?: (home: string) => void
  /** Test seam; production runs the shared short-lived app-server session. */
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

/**
 * Lists models without a live session: one short-lived read-only app-server under the given
 * account home and the shared probe budget, spawned through the SAME invocation resolver a
 * structured session launch uses — a probe that resolved a different binary or env could list
 * models the user's sessions cannot see, under their key. Its supervised session runner is the
 * one every Codex app-server RPC consumer shares.
 */
export function createCodexModelCatalogProbe(
  deps: CodexModelCatalogProbeDeps
): AgentModelCatalogProbe {
  const resolve = async (
    accountHome: Parameters<AgentModelCatalogProbe>[0],
    cwd?: string,
    lookup: AgentModelCatalogLookup = 'recover'
  ) => {
    const accountHomePath = requireLegacyAgentSessionAccountHome(accountHome).path
    const overlay = { ...deps.resolveEnv?.() }
    const readEnvironment =
      lookup === 'saved' ? deps.resolveSavedEnvironment : deps.resolveEnvironment
    const { command, environment } = await resolveCodexStructuredInvocation({
      ...deps,
      resolveEnvironment: async () => ({ ...(await readEnvironment?.()), ...overlay }),
      ...(lookup === 'recover' ? {} : { refreshEnvironmentAfterMiss: undefined }),
      ...(cwd ? { resolveWorkingDirectory: () => cwd } : {})
    })
    const args = [
      ...(cwd ? codexStructuredLaunchArgs((await deps.resolveLaunchArgs?.()) ?? []) : []),
      ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS
    ]
    const env = { ...definedEnv(environment), CODEX_HOME: accountHomePath }
    return {
      identity: { command, args, cwd, overlay: Object.entries(overlay).sort() },
      run: async (signal?: AbortSignal): Promise<AgentModelCatalogSuccess> => {
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
            // Both at once, so the account check adds no latency.
            const listed = fetchCodexModelCatalogListing({ connection: rpc, cwd })
            void listed.catch(() => {})
            const response: unknown = await rpc
              .request('account/read', { refreshToken: false }, { timeoutMs: 2_000 })
              // Unknown account status says nothing.
              .catch(() => undefined)
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
            // The verdict can be wrong (a gateway in Arguments), so a list in hand still fills the picker.
            const inHand = await listed.catch(() => null)
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
      (await resolve(home, options?.cwd ?? process.cwd())).run(options?.signal),
    { resolve, resolveLegacy: (home) => resolve(home) }
  )
}
