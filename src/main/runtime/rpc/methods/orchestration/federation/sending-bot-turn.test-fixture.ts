// A bot chat whose running turn a person opened, as the structured host serves it to Orca's readers.
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionConversationView } from '../../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { makeTestBot } from '../../../../../bots/bot.test-fixture'

export function botChat(name: string, sessionId: string) {
  const bot = makeTestBot({ name, agent: 'claude', chatSessionId: sessionId })
  const saved = agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
  const record = agentSessionConversationView({
    ...saved,
    location: { ...saved.location, workspaceId: folderWorkspaceKey(bot.folderWorkspaceId) }
  })
  return { bot, record }
}

/** A teammate's Slack message, as the cloud stamps it, and whom Orca records it for. */
export const DANA_OPENER = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ask Docs to review' }],
  origin: 'connector',
  asker: {
    source: 'slack',
    userId: 'U_DANA',
    name: 'Dana',
    role: 'member',
    place: { kind: 'public_channel', id: 'C1' }
  }
}
export const DANA_ASKER = {
  kind: 'person',
  source: 'slack',
  userId: 'U_DANA',
  name: 'Dana',
  workspaceId: null,
  role: 'member',
  placeKind: 'public_channel'
}

/** A chat's journal whose running turn `opener` opened. */
export function runningTurnItems(opener: unknown): AgentJournalRenderItem[] {
  const rows = [
    { itemId: 'u1', revision: 1, sequence: 1, observedAt: 1, body: opener },
    {
      itemId: 't1',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: { kind: 'turn', turnId: 'p1', state: 'running', userItemId: 'u1' }
    }
  ]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: journal rows with only the fields the readers read.
  return rows as AgentJournalRenderItem[]
}

/** The journal reads of a chat whose running turn `opener` opened. */
export function runningTurnReads(opener: unknown) {
  const items = opener ? runningTurnItems(opener) : []
  return async () => ({
    promptItem: async () => items[0] ?? null,
    operationWindow: async () => ({ complete: true, snapshot: { items, submissions: [] } })
  })
}
