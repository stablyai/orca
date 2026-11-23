import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionRestartCut } from '../native-chat/agent-session-wire/recovery/structured-agent-session-restart-resume-contract'
import type { LinkedConversation } from './external-conversation-links'
import {
  restartCutTurnEnds,
  type RestartCutTurnEndsDeps
} from './external-conversation-restart-cuts'

// Only a turn the last run cut, that this start did not continue, and that its conversation heard
// ends; never a live one, and never a turn of this start (its id fences the end).
const STARTED_AT = 1_800_000_000_000
const CUT: StructuredAgentSessionRestartCut = { cause: 'quit', turnId: 'turn-1' }
const linked: LinkedConversation = {
  workspace: { worktreeId: 'wt-1', sshHostId: null },
  link: {
    source: 'slack',
    externalId: 'C1:111.222',
    sessionId: 'chat-1',
    agent: 'claude',
    paneKey: 'pane-1',
    createdAt: 1,
    bot: { kind: 'bot', botId: 'bot-1' }
  }
}
const delivered: AgentJournalRenderItem = {
  itemId: 'm-1',
  sequence: 1,
  revision: 1,
  observedAt: 1,
  body: {
    kind: 'message',
    role: 'user',
    blocks: [],
    origin: 'connector',
    connectorConversation: { source: 'slack', externalId: 'C1:111.222' }
  }
}

function ends(overrides: Partial<RestartCutTurnEndsDeps> = {}) {
  return restartCutTurnEnds({
    cutByLastRun: new Set(['chat-1']),
    linksFor: (sessionId) => (sessionId === 'chat-1' ? [linked] : []),
    open: async () => null,
    offeredCuts: async () => new Map(),
    cutOf: async () => CUT,
    openerOf: async () => delivered,
    startedAt: STARTED_AT,
    now: () => STARTED_AT + 5_000,
    ...overrides
  })
}

describe('restartCutTurnEnds', () => {
  it('ends a linked chat the restart cut and nothing continued, once, as interrupted', async () => {
    expect(await ends()).toEqual([
      {
        kind: 'turn-ended',
        conversation: { source: 'slack', externalId: 'C1:111.222' },
        worktreeId: 'wt-1',
        paneKey: 'pane-1',
        turnId: STARTED_AT,
        stopReason: 'interruption',
        at: STARTED_AT + 5_000
      }
    ])
  })

  it('ends nothing for a chat the launch continued, which no longer shows the cut', async () => {
    expect(await ends({ cutOf: async () => null })).toEqual([])
  })

  it('ends nothing for a cut chat no conversation links', async () => {
    expect(await ends({ linksFor: () => [] })).toEqual([])
  })

  it('ends nothing for a linked chat the last run did not cut', async () => {
    expect(await ends({ cutByLastRun: new Set(['chat-2']) })).toEqual([])
  })

  it('ends a turn the owner typed in Orca only once the Slack mirror posted it', async () => {
    const typed: AgentJournalRenderItem = {
      ...delivered,
      body: { kind: 'message', role: 'user', blocks: [] }
    }
    expect(await ends({ openerOf: async () => typed })).toEqual([])
    const mirrored: LinkedConversation = {
      ...linked,
      link: { ...linked.link, mirrorPosts: { 'm-1': { state: 'posted', at: 1 } } }
    }
    expect(await ends({ openerOf: async () => typed, linksFor: () => [mirrored] })).toHaveLength(1)
  })

  it('ends nothing whose agent may still be running, or whose turn its conversation never heard', async () => {
    expect(await ends({ cutOf: async () => ({ ...CUT, exitUnproven: true }) })).toEqual([])
    expect(await ends({ openerOf: async () => undefined })).toEqual([])
  })
})
