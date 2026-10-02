import type { CodexStructuredLaunch } from './codex-structured-session-state'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

export function buildCodexStructuredChildEnvironment(
  launch: CodexStructuredLaunch,
  spawnToken: string,
  sessionId: string,
  logger: StructuredAgentSessionLogger
): Record<string, string> {
  return {
    // Every structured session speaks orchestration as itself: its injected id and the Orca CLI.
    ...structuredSessionChildIdentityEnv(
      sessionId,
      {
        ...launch.env,
        ...(launch.codexHome ? { CODEX_HOME: launch.codexHome } : {})
      },
      logger
    ),
    [CODEX_SPAWN_TOKEN_ENV]: spawnToken
  }
}
