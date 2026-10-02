import type { CodexStructuredLaunch } from './codex-structured-session-state'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'

export function buildCodexStructuredChildEnvironment(
  launch: CodexStructuredLaunch,
  spawnToken: string,
  sessionId: string
): Record<string, string> {
  return {
    // Every structured session speaks orchestration as itself: its injected id and the Orca CLI.
    ...structuredSessionChildIdentityEnv(sessionId, {
      ...launch.env,
      ...(launch.codexHome ? { CODEX_HOME: launch.codexHome } : {})
    }),
    [CODEX_SPAWN_TOKEN_ENV]: spawnToken
  }
}
