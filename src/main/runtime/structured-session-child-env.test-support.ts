import { sealStructuredSessionChild } from './structured-session-child-env'

export const SEALED_TEST_SPAWN_TOKEN = 'spawn-1'

/** The env the seal hands a session's child, with nothing inherited to strip. */
export function sealedChildEnv(
  sessionId: string,
  env: Record<string, string> = {}
): Record<string, string> {
  return sealStructuredSessionChild({
    sessionId,
    spawnToken: SEALED_TEST_SPAWN_TOKEN,
    env,
    inheritedEnvToDelete: []
  }).env
}
