import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'
import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { isMissingProviderExecutable } from '../provider-process/provider-executable-missing'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { runCodexAppServerSession } from './codex-app-server-session'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredLaunchResolverDeps
} from './codex-structured-launch-resolution'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import { AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'

export type CodexModelCatalogProbeDeps = Pick<
  CodexStructuredLaunchResolverDeps,
  'resolveCommand' | 'resolveEnvironment'
> & {
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
  return async (accountHome, options): Promise<AgentModelCatalogSuccess> => {
    const accountHomePath = requireLegacyAgentSessionAccountHome(accountHome).path
    const { command, environment } = await resolveCodexStructuredInvocation(deps)
    deps.prepareHome?.(accountHomePath)
    const run = deps.runSession ?? runCodexAppServerSession
    const { listing, unavailable } = await run(
      {
        command,
        args: [...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS],
        cliPath: command,
        env: { ...definedEnv(environment), CODEX_HOME: accountHomePath },
        timeoutMs: AGENT_MODEL_CATALOG_PROBE_TIMEOUT_MS,
        ...(options?.signal ? { signal: options.signal } : {})
      },
      async (rpc) => {
        // Both at once, so the account check adds no latency.
        const listed = fetchCodexModelCatalogListing({ connection: rpc })
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
      models: listing.models,
      origin: 'probe',
      ...(unavailable ? { unavailable } : {})
    }
  }
}
