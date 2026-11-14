import { readTestJournalItems } from '../journal-observation.test-support'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../shared/agent-session/journal/agent-session-journal-types'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionContextUsage } from '../../../../shared/agent-session/agent-session-context-usage'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  updateTestJournalRowJson
} from '../store-lifecycle/journal-host-database-test-support'
import { seedTestJournalHistoricalRows } from '../replay/journal-historical-inputs.test-support'
import {
  agentSessionJournalProviderHandle,
  claudeProviderHandle
} from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

export function registerJournalRowContextUsageTests(): void {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'claude',
    providerHandle: claudeProviderHandle('claude-session', null)
  }

  const USAGE = {
    inputTokens: 1,
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 90_000,
    outputTokens: 5
  }

  const FACTS: AgentSessionContextUsage[] = [
    { window: { tokens: 1_000_000, capturedAt: 3 } },
    { used: { kind: 'estimate', usage: USAGE, capturedAt: 4 } },
    { used: { kind: 'unknown', capturedAt: 5 } },
    {
      used: {
        kind: 'report',
        model: 'claude-fable-5-1[1m]',
        usedTokens: 1_100_000,
        windowTokens: 1_000_000,
        percentage: 110,
        autoCompactAtTokens: 967_000,
        categories: [
          { name: 'Messages', tokens: 1_100_000 },
          { name: 'MCP tools (deferred)', tokens: 0, deferred: true }
        ],
        capturedAt: 6
      },
      window: { tokens: 1_000_000, capturedAt: 6 }
    }
  ]

  let root: string
  let clock = 1_000
  const journals = createTrackedJournalOpener()

  const open = () =>
    journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: () => ++clock,
      mintEpoch: () => 'epoch-1'
    })

  const turn = (turnId: string, contextUsage?: AgentSessionContextUsage): AgentJournalItemBody => ({
    kind: 'turn',
    turnId,
    state: 'completed',
    ...(contextUsage ? { contextUsage } : {})
  })

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-context-usage-'))
    clock = 1_000
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  describe('context facts on replayed turn rows', () => {
    it('keeps a turn row whose facts it cannot read, and everything after it, minus the facts', async () => {
      const db = openTestJournalHostDatabase(root).db
      const epoch = 'saved-context'
      seedTestJournalHistoricalRows(db, IDENTITY, [
        {
          v: 3,
          kind: 'epoch',
          epoch,
          seq: 1,
          ts: 1_000,
          fence: 1,
          reason: 'session_created',
          providerHandle: agentSessionJournalProviderHandle(IDENTITY)
        },
        {
          v: 3,
          kind: 'item',
          epoch,
          seq: 2,
          ts: 1_000,
          fence: 1,
          itemId: 'orca:row-0',
          revision: 1,
          body: turn('turn-0', FACTS[0]),
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        },
        {
          v: 3,
          kind: 'item',
          epoch,
          seq: 3,
          ts: 1_001,
          fence: 1,
          itemId: 'orca:row-1',
          revision: 1,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'after' }] },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ])
      updateTestJournalRowJson(
        db,
        IDENTITY.sessionId,
        2,
        JSON.stringify({
          v: 3,
          kind: 'item',
          epoch,
          seq: 2,
          ts: 1_000,
          fence: 1,
          itemId: 'orca:row-0',
          revision: 1,
          body: {
            ...turn('turn-0'),
            contextUsage: { used: { kind: 'unknown', capturedAt: 'later' } }
          },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      )

      const reopened = await open()
      expect((await readTestJournalItems(reopened)).map((item) => item.body)).toEqual([
        turn('turn-0'),
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'after' }] }
      ])
    })
  })
}
