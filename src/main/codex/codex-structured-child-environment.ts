import type { CodexStructuredLaunch } from './codex-structured-session-state'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'

export function buildCodexStructuredChildEnvironment(
  launch: CodexStructuredLaunch,
  spawnToken: string
): Record<string, string> {
  return {
    ...launch.env,
    ...(launch.codexHome ? { CODEX_HOME: launch.codexHome } : {}),
    [CODEX_SPAWN_TOKEN_ENV]: spawnToken
  }
}
