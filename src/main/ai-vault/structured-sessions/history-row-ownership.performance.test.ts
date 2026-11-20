import { expect, it, vi } from 'vitest'
import * as conversationViews from '../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AiVaultListResult } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { savedChatFleet } from '../../runtime/agent-session/records/agent-session-scale.test-fixture'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  OPENS_EVERY_STRUCTURED_CHAT,
  projectStructuredAiVaultSessions
} from './structured-session-ownership'
import { historySession } from './structured-session-ownership.test-support'

// Perf contract (#43895): projecting one page of AI Vault history built an ownership view of every saved chat.

const FLEET_CHATS = 100
const PAGE_ROWS = 20

function historyPage(sessionIds: string[]): AiVaultListResult {
  const sessions = sessionIds.map((sessionId) =>
    historySession({
      id: `local:claude:${sessionId}`,
      agent: 'claude',
      sessionId,
      title: 'History row',
      filePath: `/sessions/${sessionId}.jsonl`,
      resumeCommand: `claude --resume ${sessionId}`
    })
  )
  return { sessions, issues: [], scannedAt: '2026-08-11T00:00:00.000Z' }
}

it('projects one history page onto its saved chats without listing or viewing the fleet', async () => {
  // Every walk of the saved chats builds a view per chat, wherever the store walks them from.
  const views = vi.spyOn(conversationViews, 'agentSessionConversationView')
  const fleet = await savedChatFleet(FLEET_CHATS)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: history projection reads only `deps.store`; the rest of the host is never reached.
  setStructuredAgentSessionHost({ deps: { store: fleet.store } } as never)
  const owners = Array.from(
    { length: PAGE_ROWS },
    (_, row) => fleet.chatIds[Math.floor((row * FLEET_CHATS) / PAGE_ROWS)]!
  )
  const page = historyPage(owners.map((id) => `provider-${id}-0`))
  const project = () => projectStructuredAiVaultSessions(page, OPENS_EVERY_STRUCTURED_CHAT)
  // Seeding is disk I/O on the real clock; the projections being counted run on a fake one.
  vi.useFakeTimers()
  try {
    project()
    const before = { viewsBuilt: views.mock.calls.length, ...fleet.work() }
    const projected = project()

    expect(projected.sessions.map((row) => row.structuredSession?.sessionId)).toEqual(owners)
    expect({ viewsBuilt: views.mock.calls.length, ...fleet.work() }).toEqual({
      ...before,
      viewsBuilt: before.viewsBuilt + PAGE_ROWS
    })
  } finally {
    vi.useRealTimers()
  }
})
