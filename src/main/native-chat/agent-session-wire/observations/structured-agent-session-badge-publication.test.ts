import { expect, it } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { foldAgentSessionConversationNames } from '../../../../shared/agent-session/conversation-naming/agent-session-conversation-names'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { structuredAgentSessionNamingSnapshot } from './structured-agent-session-status-feed-deps'
import type { StructuredAgentSessionStatusFeedDeps } from './structured-agent-session-status-feed-deps'

const BADGE = { label: 'Linked to Blender', icon: 'data:image/png;base64,iVBORw0KGgo=' }

function published(record: AgentSessionRecord) {
  const view = agentSessionConversationView(record)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the naming snapshot reads only these deps.
  const deps = {
    sessions: new Map(),
    getConversation: (id: string) => (id === view.sessionId ? view : null)
  } as unknown as StructuredAgentSessionStatusFeedDeps
  return structuredAgentSessionNamingSnapshot(deps, view.sessionId)
}

it("carries a chat's badge to clients, and its removal", () => {
  const record = agentSessionRecordFixture()
  const badged = foldAgentSessionConversationNames(
    new Map(),
    published({ ...record, badge: BADGE })
  )
  expect(badged.get(record.sessionId)?.badge).toEqual(BADGE)
  const cleared = foldAgentSessionConversationNames(badged, published(record))
  expect(cleared.get(record.sessionId)).not.toHaveProperty('badge')
})
