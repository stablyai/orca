import { stat } from 'node:fs/promises'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { AgentType } from '../../shared/agent-status-types'
import { contextFilePath } from './session-context-reader'
import { resolveSessionFilePath } from './session-file-resolver'

/** Provider transcripts are written continuously during any turn, so their
 *  mtime is the authoritative "conversation last moved" signal for panes whose
 *  TUI stayed silent since adoption (no title or hook evidence ever appears). */
export async function readAgentSessionTranscriptMtime(
  agent: AgentType,
  providerSession: AgentProviderSessionMetadata
): Promise<number | null> {
  const transcriptPath =
    providerSession.transcriptPath ??
    (await resolveSessionFilePath(agent, providerSession.id).catch(() => null))
  if (!transcriptPath) {
    return null
  }
  try {
    return (await stat(contextFilePath(agent, transcriptPath))).mtimeMs
  } catch {
    return null
  }
}
