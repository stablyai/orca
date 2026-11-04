import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session/journal/agent-session-journal-types'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionContextUsage } from '../../../shared/agent-session/agent-session-context-usage'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  liveTestJournalRows,
  updateTestJournalRowJson
} from './journal-host-database-test-support'
import { claudeProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

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
  const journals = createTrackedJournalOpener({ legacyInputs: true })

  const open = () =>
    journals.open({
      identity: IDENTITY,
      stateDirectory: root,
      now: () => ++clock,
      mintEpoch: () => 'epoch-1'
    })

  function row(ordinal: number): AgentJournalItemIdentity {
    return { provider: 'orca', clientMessageId: `row-${ordinal}` }
  }

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
      const journal = await open()
      await journal.appendItem(row(0), turn('turn-0', FACTS[0]), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
      await journal.appendItem(
        row(1),
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'after' }] },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await journal.close()
      const opened = await openTestJournalHostDatabase(root)
      try {
        const rowJson = (await liveTestJournalRows(opened, IDENTITY.sessionId))[1]?.rowJson ?? ''
        const future = JSON.parse(rowJson)
        future.body.contextUsage = { used: { kind: 'unknown', capturedAt: 'later' } }
        updateTestJournalRowJson(opened, IDENTITY.sessionId, 2, JSON.stringify(future))
      } finally {
        await opened.close()
      }

      const reopened = await open()
      expect(reopened.snapshot().items.map((item) => item.body)).toEqual([
        turn('turn-0'),
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'after' }] }
      ])
    })
  })
}
