import type { CodexStructuredLaunch } from './codex-structured-session-state'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'
import {
  NATIVE_CHAT_VISUALS_DIR_ENV,
  withNativeChatVisualsEnv
} from '../native-chat/native-chat-visuals-delivery'

export function buildCodexStructuredChildEnvironment(
  launch: CodexStructuredLaunch,
  spawnToken: string,
  sessionId: string
): Record<string, string> {
  return {
    // Every structured session speaks orchestration as itself: its injected id and the Orca CLI.
    ...structuredSessionChildIdentityEnv(
      sessionId,
      withNativeChatVisualsEnv(
        {
          ...launch.env,
          ...(launch.codexHome ? { CODEX_HOME: launch.codexHome } : {})
        },
        launch.visuals ?? null
      )
    ),
    [CODEX_SPAWN_TOKEN_ENV]: spawnToken
  }
}

/** The child's env overlay, and the keys removed from what it inherits: without visuals, a folder
 *  Orca itself inherited (started from a chat) names another chat's folder. */
export function codexStructuredChildEnvironment(
  launch: CodexStructuredLaunch,
  spawnToken: string,
  sessionId: string
): { env: Record<string, string>; envToDelete?: readonly string[] } {
  return {
    env: buildCodexStructuredChildEnvironment(launch, spawnToken, sessionId),
    ...(launch.visuals ? {} : { envToDelete: [NATIVE_CHAT_VISUALS_DIR_ENV] })
  }
}
