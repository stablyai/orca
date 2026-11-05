import { parseAgentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import { prepareLegacyTranscriptImport } from './agent-session-journal/journal-legacy-import'
import { resolveStructuredAgentSessionAdoptionForCreate } from '../runtime/agent-session/structured-agent-session-create-adoption'
import { structuredAgentRuntimeMetadata } from '../runtime/structured-agent-runtime-metadata'

/** An imported root has no hosted turn receipt; ask the same pinned native history importer. */
export async function importedAgentSessionForkTipSettled(input: {
  record: AgentSessionRecord
  providerSessionId: string
  selectedItemId: string
  workspaceCwd: string
  launchEnv: NodeJS.ProcessEnv
}): Promise<boolean> {
  const identity = parseAgentJournalItemKey(input.selectedItemId)
  const metadata = structuredAgentRuntimeMetadata(input.record.provider)
  if (
    identity?.provider !== 'legacy' ||
    identity.sessionId !== input.providerSessionId ||
    !metadata?.transcriptImport
  ) {
    return false
  }
  const source = await resolveStructuredAgentSessionAdoptionForCreate({
    settings: {},
    agent: input.record.provider,
    transcriptImport: {
      ...metadata.transcriptImport,
      accountHomeCandidates: () => [input.record.accountHome]
    },
    providerSessionId: input.providerSessionId,
    selectedAccountHome: input.record.accountHome,
    workspaceCwd: input.workspaceCwd,
    launchEnv: input.launchEnv
  })
  const imported = await prepareLegacyTranscriptImport({
    agent: input.record.provider,
    sessionId: input.providerSessionId,
    options: { filePath: source.transcriptPath }
  })
  return imported.ok && Boolean(imported.forkTipItemIds?.includes(input.selectedItemId))
}
