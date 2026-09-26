import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const journals = createTrackedJournalOpener()
let root: string | null = null

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

async function openJournal(name: string): Promise<AgentSessionJournal> {
  root ??= await mkdtemp(join(tmpdir(), 'orca-conversations-'))
  return journals.open({ identity: IDENTITY, journalDir: join(root, name) })
}

function session(journal: AgentSessionJournal) {
  return {
    journal,
    params: hostTestAttachParams(null),
    child: null
  }
}

function appendStatus(journal: AgentSessionJournal, text: string) {
  return journal.appendItem(
    { provider: 'orca', clientMessageId: text },
    { kind: 'status', text },
    { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

describe('a conversation delivers what its journal commits', () => {
  it('delivers an append that no writer published', async () => {
    const deliver = vi.fn()
    const conversations = new StructuredAgentSessionConversations({
      deliver,
      onDeliveryError: vi.fn(),
      now: () => 0
    })
    const journal = await openJournal('a')
    conversations.set('session-1', session(journal))

    await appendStatus(journal, 'written')

    // Already delivered when the writer's await returns, as an explicit publish would have been.
    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledWith('session-1', journal)
  })

  it('binds a handle set through a plain map reference', async () => {
    const deliver = vi.fn()
    // Collaborators hold the host's map as a plain `Map`; `set` still reaches the binding.
    const sessions: Map<string, StructuredAgentSessionHostSession> =
      new StructuredAgentSessionConversations({
        deliver,
        onDeliveryError: vi.fn(),
        now: () => 0
      })
    const journal = await openJournal('a')
    sessions.set('session-1', session(journal))

    await appendStatus(journal, 'through the plain map')

    expect(deliver).toHaveBeenCalledExactlyOnceWith('session-1', journal)
  })

  it('delivers an epoch replacement, which readers must reload from', async () => {
    const deliver = vi.fn()
    const conversations = new StructuredAgentSessionConversations({
      deliver,
      onDeliveryError: vi.fn(),
      now: () => 0
    })
    const journal = await openJournal('a')
    conversations.set('session-1', session(journal))

    await journal.replaceEpochItems('handle_forked', 0, [])

    expect(deliver).toHaveBeenCalledExactlyOnceWith('session-1', journal)
  })

  it('delivers nothing for a handle the conversation has replaced', async () => {
    const deliver = vi.fn()
    const conversations = new StructuredAgentSessionConversations({
      deliver,
      onDeliveryError: vi.fn(),
      now: () => 0
    })
    const replaced = await openJournal('a')
    const current = await openJournal('b')
    conversations.set('session-1', session(replaced))
    conversations.set('session-1', session(current))

    await appendStatus(replaced, 'stale')
    expect(deliver).not.toHaveBeenCalled()

    await appendStatus(current, 'live')
    expect(deliver).toHaveBeenCalledExactlyOnceWith('session-1', current)
  })

  it('delivers nothing once the conversation is dropped', async () => {
    const deliver = vi.fn()
    const conversations = new StructuredAgentSessionConversations({
      deliver,
      onDeliveryError: vi.fn(),
      now: () => 0
    })
    const journal = await openJournal('a')
    conversations.set('session-1', session(journal))
    conversations.delete('session-1')

    await appendStatus(journal, 'after close')

    expect(deliver).not.toHaveBeenCalled()
  })

  it('reports a reader failure without failing the durable write', async () => {
    const failure = new Error('reader failed')
    const onDeliveryError = vi.fn()
    const conversations = new StructuredAgentSessionConversations({
      deliver: () => {
        throw failure
      },
      onDeliveryError,
      now: () => 0
    })
    const journal = await openJournal('a')
    conversations.set('session-1', session(journal))

    await expect(appendStatus(journal, 'durable')).resolves.toMatchObject({
      itemId: expect.any(String)
    })

    expect(onDeliveryError).toHaveBeenCalledExactlyOnceWith('session-1', failure)
    expect(journal.snapshot().items.map((item) => item.body)).toContainEqual({
      kind: 'status',
      text: 'durable'
    })
  })
})
