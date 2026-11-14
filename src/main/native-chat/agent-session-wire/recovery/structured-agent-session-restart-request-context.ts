import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import {
  agentSessionContextSnapshotPath,
  writeAgentSessionContextSnapshot
} from '../../conversation-context/agent-session-context-snapshots'
import { projectSavedChatContextItems } from '../../conversation-context/agent-session-saved-prompt-text'
import { structuredAgentSessionAttentionPrompts } from '../observations/structured-agent-session-attention-prompts'
import { formatWorkerTranscriptMessage } from '../../../../shared/worker-transcript-text'
import { toLinuxPath } from '../../../../shared/wsl-paths'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { restartContinuationBody } from './structured-agent-session-restart-continuation-envelope'
import type { AgentSessionResumeMarker } from '../../../../shared/agent-session/lifecycle/agent-session-resume-marker'

const contextKey = (sessionId: string) => `restart:${sessionId}`

/** The reference stays stable across retries; its contents come from the journal's attention authority. */
export function restartBodyWithRequestContext(
  stateDirectory: string,
  marker: AgentSessionResumeMarker,
  wsl: boolean,
  journal: AgentSessionJournal
): AgentJournalMessageItem {
  const body = restartContinuationBody(marker)
  if (!structuredAgentSessionAttentionPrompts(journal, null, () => false).length) {
    return body
  }
  const path = agentSessionContextSnapshotPath(stateDirectory, contextKey(marker.sessionId))
  return {
    ...body,
    blocks: [
      ...body.blocks,
      {
        type: 'text',
        text: `Before continuing, read the saved question and approval state captured for this restart in ${JSON.stringify(wsl ? toLinuxPath(path) : path)}. Follow the pending-request instructions above for each request still open in that snapshot.`
      }
    ]
  }
}

export async function writeRestartRequestContext(
  stateDirectory: string,
  sessionId: string,
  journal: AgentSessionJournal,
  body: AgentJournalMessageItem
): Promise<void> {
  const key = contextKey(sessionId)
  const path = agentSessionContextSnapshotPath(stateDirectory, key)
  if (
    !body.blocks.some(
      (block) =>
        block.type === 'text' &&
        (block.text.includes(JSON.stringify(path)) ||
          block.text.includes(JSON.stringify(toLinuxPath(path))))
    )
  ) {
    return
  }
  const requests = await journal.readInOrder(() =>
    structuredAgentSessionAttentionPrompts(journal, null, () => false)
  )
  const text = projectSavedChatContextItems(requests)
    .map(formatWorkerTranscriptMessage)
    .join('\n\n')
  await writeAgentSessionContextSnapshot(
    stateDirectory,
    key,
    text || 'No saved question or approval is pending at this restart checkpoint.'
  )
}
