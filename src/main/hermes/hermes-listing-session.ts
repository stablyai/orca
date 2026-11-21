import { runProcess } from '@orca/process-host'
import { processEnvWithoutAgentSession } from '../../shared/agent-launch/startup/parent-agent-session-env'
import type { AcpListingSession } from '../acp/discovery/acp-model-discovery-policy'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'

const DELETE_TIMEOUT_MS = 15_000
// Hermes resolves `sessions delete` via `LIKE '<prefix>%'` when no exact row matches; require a
// non-flag, non-prefix-ambiguous ID so a malformed ACP reply cannot match a user's conversation.
const SAFE_HERMES_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,}$/

/** Hermes deletes a session only through its CLI, after the listing process has exited. */
export async function discardHermesListingSession(session: AcpListingSession): Promise<void> {
  if (!SAFE_HERMES_SESSION_ID.test(session.sessionId)) {
    throw new Error(`refusing to delete unsafe Hermes listing session id: ${session.sessionId}`)
  }
  const result = await runProcess({
    program: session.command,
    args: [...session.prefixArgs, 'sessions', 'delete', '--yes', '--', session.sessionId],
    cwd: session.launchCwd ?? session.cwd,
    env: resolveProviderChildEnv(
      { env: { ...session.env }, envToDelete: session.envToDelete },
      processEnvWithoutAgentSession()
    ),
    terminationBarrier: true,
    timeoutMs: DELETE_TIMEOUT_MS
  })
  if (result.timedOut) {
    throw new Error(`hermes sessions delete timed out for ${session.sessionId}`)
  }
  if (result.code === 1 && result.stdout.includes(`No session '${session.sessionId}'`)) {
    return
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim()
    throw new Error(
      `hermes sessions delete failed for ${session.sessionId}${detail ? `: ${detail}` : ''}`
    )
  }
}
