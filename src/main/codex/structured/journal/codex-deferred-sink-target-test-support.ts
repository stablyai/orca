import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { TrackedJournalOpener } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { StructuredAgentSessionEventTarget } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'

/** A deferred sink target over a real SQL journal for one Codex thread. */
export async function journalTarget(
  journals: TrackedJournalOpener,
  stateDirectory: string,
  publishes: string[] = []
): Promise<StructuredAgentSessionEventTarget> {
  const journal = await journals.open({
    identity: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-abc')
    },
    stateDirectory
  })
  return {
    fence: 7,
    journal,
    publish: () => {
      publishes.push('publish')
    }
  }
}
