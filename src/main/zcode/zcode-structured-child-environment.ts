import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { structuredSessionChildIdentityEnv } from '../runtime/structured-session-child-identity-env'
import { ACP_CHILD_ENV_TO_DELETE } from '../acp/acp-launch-specs'
import type { ZcodeStructuredLaunch } from './zcode-structured-launch-resolution'

/**
 * The child's env overlay, and the keys removed from what it inherits. A structured session
 * speaks orchestration as itself (injected session id, Orca CLI on PATH); the pane-identity keys
 * an inherited Orca environment carries would let the agent's own status hooks report for this
 * session too, and the structured session is its one status producer.
 */
export function zcodeStructuredChildEnvironment(
  launch: ZcodeStructuredLaunch,
  sessionId: string
): { env: Record<string, string>; envToDelete?: readonly string[] } {
  const env = structuredSessionChildIdentityEnv(sessionId, {
    ...launch.env,
    ...(launch.zcodeHome ? { ZCODE_HOME: launch.zcodeHome } : {})
  })
  return {
    env,
    envToDelete: ACP_CHILD_ENV_TO_DELETE
  }
}

export type ZcodeChildLaunch = ProviderProcessLaunch
