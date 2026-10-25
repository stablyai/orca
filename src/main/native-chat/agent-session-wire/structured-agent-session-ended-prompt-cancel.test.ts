// Dismiss stale-generation prompts in the journal without stopping current turns or withdrawing queued work.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { claudePromptCancelRoute } from '../../claude/claude-structured-prompt-replies'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import type { StructuredAgentSessionChatStopRun } from './structured-agent-session-chat-stop'
import { structuredQueuePauses } from './structured-agent-session-queued-pause'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { cancelStructuredAgentSessionPrompt } from './structured-agent-session-prompt-cancel'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const ENDED = 1
const LIVE = 2

const journals = createTrackedJournalOpener()
let root: string | null = null

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function endedCardAndLiveTurn(): Promise<{ journal: AgentSessionJournal; itemId: string }> {
  root = await mkdtemp(join(tmpdir(), 'orca-ended-prompt-cancel-'))
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  const turn = (turnId: string, fence: number) =>
    journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId, ordinal: 0 },
      { kind: 'turn', turnId, state: 'running', startedAt: fence },
      { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  const old = await turn('turn-1', ENDED)
  const pending = {
    state: 'pending' as const,
    selectedOptionId: null,
    resolvedBy: null,
    resolvedAt: null
  }
  const card = await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 1 },
    {
      kind: 'question',
      question: 'Which?',
      options: [{ id: 'a', label: 'A' }],
      resolution: pending
    },
    { fence: ENDED, turnScope: { kind: 'turn', turnItemId: old.itemId } }
  )
  await turn('turn-2', LIVE)
  await journal.queuedMessages.insert({
    messageId: 'queued-1',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'after this' }] }
  })
  return { journal, itemId: card.itemId }
}

function queueUntouched(journal: AgentSessionJournal): void {
  expect(journal.queuedMessages.list().map((card) => [card.messageId, card.state])).toEqual([
    ['queued-1', 'waiting']
  ])
  expect(structuredQueuePauses(journal)).toEqual([])
}

function provider(routePromptCancel?: StructuredAgentSessionAdapter['routePromptCancel']) {
  return {
    cancelTurn: vi.fn(async (_input: { turnId?: string; prompt?: unknown }) => ({
      cancelled: true
    })),
    dismissPrompt: vi.fn(async () => undefined),
    ...(routePromptCancel ? { routePromptCancel } : {})
  }
}

function context(
  journal: AgentSessionJournal,
  adapter: ReturnType<typeof provider>
): AgentSessionTurnContext {
  return {
    logger: createStructuredAgentSessionLogger(),
    sessionId: 'session-1',
    journal,
    fence: LIVE,
    agents: NO_STRUCTURED_AGENTS,
    agent: 'codex',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a Cancel reaches only cancelTurn, dismissPrompt and routePromptCancel, all supplied.
    adapter: adapter as unknown as StructuredAgentSessionAdapter,
    persistOptions: async () => undefined,
    resolvedBy: 'client-1',
    publish: vi.fn(),
    now: () => 1
  }
}

function chatStop() {
  return vi.fn(async (): Promise<StructuredAgentSessionChatStopRun> => ({
    outcome: { ok: true, value: { turnId: 'turn-2', cancelled: true } },
    endsSession: false
  }))
}

function resolution(journal: AgentSessionJournal, itemId: string) {
  const body = journal.snapshot().items.find((item) => item.itemId === itemId)?.body
  return body?.kind === 'approval' || body?.kind === 'question' ? body.resolution.state : undefined
}

describe('a question an ended generation raised, cancelled from a client that still shows it', () => {
  it('is dismissed only, even when the request names the live turn: no Stop, the queue untouched', async () => {
    const { journal, itemId } = await endedCardAndLiveTurn()
    const agent = provider(claudePromptCancelRoute)
    const stop = chatStop()
    const interrupt = vi.fn()

    const result = await cancelStructuredAgentSessionPrompt(
      context(journal, agent),
      { turnId: 'turn-2', prompt: { itemId, expectedRevision: 1 } },
      { stop, interrupt }
    )

    expect(result).toMatchObject({ ok: true, value: { turnId: 'turn-2', cancelled: true } })
    expect(resolution(journal, itemId)).toBe('cancelled')
    expect(stop).not.toHaveBeenCalled()
    expect(interrupt).not.toHaveBeenCalled()
    expect(agent.cancelTurn).not.toHaveBeenCalled()
    expect(agent.dismissPrompt).not.toHaveBeenCalled()
    queueUntouched(journal)
  })
})
