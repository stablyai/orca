import { getSpawnArgsForWindows } from '../win32-utils'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { runCodexAppServerSession } from './codex-app-server-session'
import { fetchCodexModelCatalogListing } from './codex-structured-model-catalog'
import {
  resolveCodexStructuredInvocation,
  type CodexStructuredLaunchResolverDeps
} from './codex-structured-launch-resolution'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'

// Why 15s: the whole probe session is SIGKILLed at the deadline, and a cold
// `model/list` may pay one network /models fetch behind provider auth.
const CODEX_MODEL_CATALOG_PROBE_TIMEOUT_MS = 15_000

export type CodexModelCatalogProbeDeps = Pick<
  CodexStructuredLaunchResolverDeps,
  'resolveCommand' | 'resolveEnvironment'
> & {
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
 * Lists models without a live session: one short-lived read-only app-server
 * under the given account home, spawned through the SAME invocation resolver
 * a structured session launch uses — a probe that resolved a different binary
 * or env could list models the user's sessions cannot see, under their key.
 */
export function createCodexModelCatalogProbe(
  deps: CodexModelCatalogProbeDeps
): AgentModelCatalogProbe {
  return async (accountHomePath: string): Promise<AgentModelCatalogSuccess> => {
    const { command, environment } = await resolveCodexStructuredInvocation(deps)
    const { spawnCmd, spawnArgs } = getSpawnArgsForWindows(command, [
      ...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS
    ])
    const run = deps.runSession ?? runCodexAppServerSession
    const listing = await run(
      {
        command: spawnCmd,
        args: spawnArgs,
        cliPath: command,
        env: { ...definedEnv(environment), CODEX_HOME: accountHomePath },
        timeoutMs: CODEX_MODEL_CATALOG_PROBE_TIMEOUT_MS
      },
      (rpc) => fetchCodexModelCatalogListing({ connection: rpc })
    )
    if (listing.models.length === 0) {
      throw new Error('codex app-server listed no models')
    }
    return {
      models: listing.models,
      fastModeTierByModel: listing.fastModeTierByModel,
      origin: 'probe'
    }
  }
}
