// A Cancel that names a card an ended generation raised, from a client that still shows it: the
// card is dismissed in the journal alone, no provider is asked about it, and the live generation's
// turn is stopped only by a request that names it (an older phone's Stop carries the card it shows).

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
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { cancelStructuredAgentSessionPrompt } from './structured-agent-session-prompt-cancel'
import { performCancel, type AgentSessionTurnContext } from './structured-agent-session-turns'

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

/** Generation 1 raised a card and ended without its cleanup; generation 2 runs `turn-2`. */
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
  const card = await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 1 },
    {
      kind: 'approval',
      title: 'Approve?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: ENDED, turnScope: { kind: 'turn', turnItemId: old.itemId } }
  )
  await turn('turn-2', LIVE)
  return { journal, itemId: card.itemId }
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
  return body?.kind === 'approval' ? body.resolution.state : undefined
}

describe('a card an ended generation raised, cancelled from a client that still shows it', () => {
  it.each([
    ['naming no turn', undefined],
    ["naming the ended generation's turn", 'turn-1']
  ])(
    'ACP (no card route): %s, it is dismissed and the live turn is not interrupted',
    async (_name, turnId) => {
      const { journal, itemId } = await endedCardAndLiveTurn()
      const acp = provider()
      const stop = chatStop()
      const interrupt = vi.fn()

      const result = await cancelStructuredAgentSessionPrompt(
        context(journal, acp),
        { ...(turnId ? { turnId } : {}), prompt: { itemId, expectedRevision: 1 } },
        { stop, interrupt }
      )

      expect(result).toMatchObject({ ok: true, value: { cancelled: true } })
      expect(resolution(journal, itemId)).toBe('cancelled')
      expect(interrupt).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
      expect(acp.cancelTurn).not.toHaveBeenCalled()
      expect(acp.dismissPrompt).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['Claude (an approval routes to a dismissal)', claudePromptCancelRoute],
    ['Codex (no card route)', undefined]
  ])("%s: an older phone's Stop carrying it still stops the live turn", async (_name, route) => {
    const { journal, itemId } = await endedCardAndLiveTurn()
    const agent = provider(route)
    const stop = chatStop()
    const interrupt = vi.fn()

    const result = await cancelStructuredAgentSessionPrompt(
      context(journal, agent),
      { turnId: 'turn-2', prompt: { itemId, expectedRevision: 1 } },
      { stop, interrupt }
    )

    expect(result).toMatchObject({ ok: true, value: { turnId: 'turn-2', cancelled: true } })
    expect(stop).toHaveBeenCalledOnce()
    expect(interrupt).not.toHaveBeenCalled()
    expect(agent.dismissPrompt).not.toHaveBeenCalled()
    expect(resolution(journal, itemId)).toBe('cancelled')
  })

  it('reaching the Stop itself, the card is dropped and the live turn is stopped plainly', async () => {
    const { journal, itemId } = await endedCardAndLiveTurn()
    const codex = provider()

    await performCancel(context(journal, codex), {
      clientOperationId: 'cancel-1',
      turnId: 'turn-2',
      prompt: { itemId, expectedRevision: 1 }
    })

    expect(codex.cancelTurn).toHaveBeenCalledOnce()
    expect(codex.cancelTurn.mock.calls[0]?.[0]).not.toHaveProperty('prompt')
    expect(codex.cancelTurn.mock.calls[0]?.[0]).toMatchObject({ turnId: 'turn-2' })
    expect(resolution(journal, itemId)).toBe('cancelled')
  })
})
