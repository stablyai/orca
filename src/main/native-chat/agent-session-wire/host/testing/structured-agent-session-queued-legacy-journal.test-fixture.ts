import {
  seedLegacyTestJournal,
  openTestJournalHostDatabase
} from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'

import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  HOST_TEST_NOW,
  HOST_TEST_THREAD
} from './structured-agent-session-host-test-data.test-fixture'
import type { StructuredAgentSessionHost } from '../structured-agent-session-host'

export function seedQueuedRigLegacyJournal(
  root: string,
  sessionId: string,
  agent?: 'claude'
): (host: StructuredAgentSessionHost) => void {
  seedLegacyTestJournal(openTestJournalHostDatabase(root), {
    identity: {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: agent ?? 'codex',
      providerHandle:
        agent === 'claude'
          ? claudeProviderHandle(HOST_TEST_THREAD, null)
          : codexProviderHandle(HOST_TEST_THREAD)
    },
    now: () => HOST_TEST_NOW
  })
  return () => {}
}
