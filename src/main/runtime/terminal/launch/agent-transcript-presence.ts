import { access } from 'node:fs/promises'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

/** Whether a host-built resume should start the session fresh: only when this host can see the agent's files
 * (no SSH connection) and the transcript its hooks named is not on disk, i.e. the session never took a turn.
 * Anything unproven (no recorded path, another agent, an unreadable folder) keeps the plain resume. */
export async function hasMissingAgentTranscript(
  agent: TuiAgent,
  providerSession: Pick<AgentProviderSessionMetadata, 'transcriptPath'>,
  connectionId: string | null | undefined,
  exists: (path: string) => Promise<boolean> = pathExists
): Promise<boolean> {
  const transcriptPath = providerSession.transcriptPath?.trim()
  if (agent !== 'claude' || connectionId || !transcriptPath) {
    return false
  }
  return !(await exists(transcriptPath))
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    // Only a missing file proves no transcript; a permission error says nothing about it.
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
  }
}
