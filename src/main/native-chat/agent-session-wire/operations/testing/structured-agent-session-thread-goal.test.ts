import { testJournalWorkReader } from '../../../agent-session-journal/journal-current-work.test-fixture'
import { readTestJournalItems } from '../../../agent-session-journal/journal-observation.test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from '../../providers/structured-agent-session-adapter'
import { performThreadGoalChange } from '../structured-agent-session-thread-goal'
import type { AgentSessionTurnContext } from '../structured-agent-session-turns'
import { claudeAndCodexAgents } from '../../providers/testing/structured-agent-session-adapter-router.test-fixture'
import { createStructuredAgentSessionLogger } from '../../host/structured-agent-session-logger'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function openJournal(onCommitted?: () => void): Promise<AgentSessionJournal> {
  root ??= await mkdtemp(join(tmpdir(), 'orca-thread-goal-'))
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  if (onCommitted) {
    journal.observeCommits(onCommitted)
  }
  return journal
}

function context(
  journal: AgentSessionJournal,
  double: Partial<StructuredAgentSessionAdapter>,
  agent = 'codex'
): AgentSessionTurnContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the goal path reads only the goal methods.
  const adapter = double as StructuredAgentSessionAdapter
  return {
    logger: createStructuredAgentSessionLogger(),
    sessionId: 'session-1',
    journal,
    readWork: testJournalWorkReader(journal, 1),
    fence: 1,
    adapter,
    agents: claudeAndCodexAgents(adapter),
    agent,
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    now: () => 1
  }
}

describe('performThreadGoalChange', () => {
  it('removes the objective when the provider refuses the goal', async () => {
    const journal = await openJournal()
    const ctx = context(journal, {
      changeThreadGoal: async () => ({ ok: false, rejected: 'goals feature is disabled' })
    })

    const result = await performThreadGoalChange(ctx, {
      clientOperationId: 'op-2',
      change: { kind: 'set', objective: 'Ship the parser' }
    })

    expect(result).toEqual({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'providerRejected' },
        message: 'goals feature is disabled'
      }
    })
    expect(await readTestJournalItems(journal)).toEqual([])
  })

  it('retains the objective when a lost reply leaves application unknown', async () => {
    const journal = await openJournal()
    const ctx = context(journal, {
      changeThreadGoal: async () => {
        throw new Error('connection closed')
      }
    })

    await expect(
      performThreadGoalChange(ctx, {
        clientOperationId: 'op-3',
        change: { kind: 'set', objective: 'Ship the parser' }
      })
    ).rejects.toThrow('connection closed')
    expect((await readTestJournalItems(journal)).map((item) => item.body)).toEqual([
      expect.objectContaining({ sentAs: 'goal' })
    ])
  })
})
