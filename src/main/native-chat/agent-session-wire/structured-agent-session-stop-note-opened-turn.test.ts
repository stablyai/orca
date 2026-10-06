// A Stop found with no turn running can wait for one to open and interrupt it. Taken, its note is
// the turn the provider says it took; refused, the row stays with the conversation, as before.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { performCancel, type AgentSessionTurnContext } from './structured-agent-session-turns'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const TURN = { provider: 'codex' as const, threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 }

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

/** A Stop with no turn running whose cancel opens turn-1 while it waits, then answers `outcome`. */
async function stopWhileTheTurnOpens(
  outcome: Awaited<ReturnType<StructuredAgentSessionAdapter['cancelTurn']>>
) {
  root = await mkdtemp(join(tmpdir(), 'orca-stop-note-opened-turn-'))
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  const ctx: AgentSessionTurnContext = {
    logger: createStructuredAgentSessionLogger(),
    sessionId: 'session-1',
    journal,
    fence: 1,
    agents: NO_STRUCTURED_AGENTS,
    agent: 'codex',
    adapter: {
      acquire: vi.fn(),
      dispatch: vi.fn(),
      closeSession: vi.fn(),
      cancelTurn: vi.fn(async () => {
        await journal.appendItem(
          TURN,
          { kind: 'turn', turnId: 'turn-1', state: 'running' },
          { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        return outcome
      }),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    },
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    now: () => 1
  }
  await performCancel(ctx, { clientOperationId: 'stop-1' })
  return journal
    .snapshot()
    .items.flatMap((item) =>
      item.body.kind === 'status' ? [{ itemId: item.itemId, turnScope: item.turnScope }] : []
    )
}

describe('a Stop that waited for a turn to open', () => {
  it('keeps its note with that turn when the interrupt took it', async () => {
    expect(await stopWhileTheTurnOpens({ cancelled: true, turnId: 'turn-1' })).toEqual([
      {
        itemId: agentJournalItemKey(structuredAgentSessionStopNoteIdentity('turn-1')),
        turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(TURN) }
      }
    ])
  })

  it("leaves a refused Stop's row with the conversation, as before", async () => {
    expect(
      await stopWhileTheTurnOpens({
        cancelled: false,
        refusal: { detail: { text: 'failed to interrupt turn', audience: 'person' } }
      })
    ).toEqual([
      {
        itemId: agentJournalItemKey(structuredAgentSessionStopNoteIdentity('stop-1')),
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ])
  })
})
