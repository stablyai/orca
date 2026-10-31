import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import {
  StructuredAgentSessionConversations,
  type JournalPublication
} from './structured-agent-session-conversations'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
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
  return journals.open({
    identity: IDENTITY,
    mintEpoch: () => 'conversations-test-epoch',
    stateDirectory: join(root, name)
  })
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
      logger: recordingStructuredAgentSessionLogger().logger,
      now: () => 0
    })
    const journal = await openJournal('a')
    conversations.set('session-1', session(journal))

    await appendStatus(journal, 'written')

    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledWith('session-1', journal)
  })

  it('binds a handle set through a plain map reference', async () => {
    const deliver = vi.fn()
    // Plain Map references must still invoke commit binding through overridden set.
    const sessions: Map<string, StructuredAgentSessionHostSession> =
      new StructuredAgentSessionConversations({
        deliver,
        logger: recordingStructuredAgentSessionLogger().logger,
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
      logger: recordingStructuredAgentSessionLogger().logger,
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
      logger: recordingStructuredAgentSessionLogger().logger,
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
      logger: recordingStructuredAgentSessionLogger().logger,
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
    const log = recordingStructuredAgentSessionLogger()
    const conversations = new StructuredAgentSessionConversations({
      deliver: () => {
        throw failure
      },
      logger: log.logger,
      now: () => 0
    })
    const journal = await openJournal('a')
    conversations.set('session-1', session(journal))

    await expect(appendStatus(journal, 'durable')).resolves.toMatchObject({
      itemId: expect.any(String)
    })

    expect(log.entries.map((entry) => entry.fields)).toEqual([
      { scope: 'journal-delivery', sessionId: 'session-1', error: failure }
    ])
    expect(journal.snapshot().items.map((item) => item.body)).toContainEqual({
      kind: 'status',
      text: 'durable'
    })
  })
})

describe('internal publication lifetime, independently of presentation', () => {
  it('retires source slots on replacement/clear, isolates bad readers, and fences old disposers', async () => {
    const conversations = new StructuredAgentSessionConversations({
      deliver: vi.fn(),
      logger: recordingStructuredAgentSessionLogger().logger,
      now: () => 0
    })
    const old = await openJournal('old'),
      current = await openJournal('current')
    const next = vi.fn(),
      error = vi.fn(),
      bad = vi.fn()
    const release = conversations.observeConversationPublications('session-1', { next, error })
    conversations.set('session-1', session(old))
    const oldSource = next.mock.lastCall![0].source
    conversations.set('session-1', session(old))
    expect(next).toHaveBeenCalledTimes(2)
    conversations.set('session-1', session(current))
    expect(next.mock.lastCall![0].source).not.toBe(oldSource)
    expect(current.cursor()).toEqual(old.cursor())
    const fail = conversations.observeConversationPublications('session-1', {
      next: (hint) => {
        if (hint.kind === 'commit') {
          throw new Error('consumer')
        }
      },
      error: bad
    })
    await appendStatus(current, 'durable despite consumer failure')
    expect(bad).toHaveBeenCalledOnce()
    expect(next.mock.lastCall![0]).toMatchObject({ kind: 'commit', journal: current })
    const count = next.mock.calls.length
    await appendStatus(old, 'detached')
    expect(next).toHaveBeenCalledTimes(count)
    const map: Map<string, StructuredAgentSessionHostSession> = conversations
    map.clear()
    expect(next.mock.lastCall![0]).toMatchObject({ kind: 'detach', source: null, journal: null })
    await appendStatus(current, 'after clear')
    expect(next).toHaveBeenCalledTimes(count + 1)
    release()
    release()
    fail()
    const successor = { next: vi.fn(), error: vi.fn() }
    const releaseB = conversations.observeConversationPublications('session-1', successor)
    release()
    conversations.publish('session-1', 'operational')
    expect(successor.next.mock.lastCall![0].kind).toBe('operational')
    const releaseC = conversations.observeConversationPublications('session-1', successor)
    releaseB()
    releaseB()
    conversations.set('session-1', session(current))
    await appendStatus(current, 'independent acquisition survives')
    expect(successor.next.mock.lastCall![0].kind).toBe('commit')
    let reentrantRelease = () => {}
    const reentrant = vi.fn()
    const initialFailure = conversations.observeConversationPublications('session-1', {
      next: () => {
        throw new Error('initial reader')
      },
      error: () => {
        reentrantRelease = conversations.observeConversationPublications('session-1', {
          next: reentrant,
          error: vi.fn()
        })
      }
    })
    initialFailure()
    conversations.publish('session-1', 'operational')
    expect(reentrant.mock.lastCall![0].kind).toBe('operational')
    conversations.endPublications()
    expect(successor.next.mock.lastCall![0].kind).toBe('end')
    expect(reentrant.mock.lastCall![0].kind).toBe('end')
    releaseC()
    reentrantRelease()
    expect(conversations['observers'].size).toBe(0)
    const listener = vi.fn()
    const before = old.observeCommits(listener)
    const after = old.observeCommits(listener)
    before()
    before()
    await appendStatus(old, 'new listener survives old disposal')
    expect(listener).toHaveBeenCalledOnce()
    after()
    after()
    const settle = vi.fn(),
      prior = old.stopMarks.observeSettleEdges(settle)
    const dispose = old.stopMarks.observeSettleEdges(settle)
    prior()
    old.stopMarks.settled({ settling: true }, 'turn')
    expect(settle).toHaveBeenCalledOnce()
    dispose()
    expect(error).not.toHaveBeenCalled()
  })

  it('forwards actual host commits, Stop/work/restore/drop/clear/end without starting or sending to read', async () => {
    const { createQueuedMessageTestRig } =
      await import('./structured-agent-session-queued-message-rig.test-fixture')
    const { HOST_TEST_SESSION: id } = await import('./structured-agent-session-host-test-data')
    const rig = await createQueuedMessageTestRig({ restartable: true })
    const events: JournalPublication[] = []
    const started = rig.starts.mock.calls.length,
      dispatched = rig.dispatch.mock.calls.length
    const release = rig.host.observeConversationPublications(id, {
      next: (hint) => events.push(hint),
      error: (error) => {
        throw error
      }
    })
    try {
      const { sessions } = rig.host.collaboratorsForTests()
      const first = sessions.get(id)!.journal
      await appendStatus(first, 'zero display readers')
      expect(events.findLast((event) => event.kind === 'commit')).toMatchObject({
        kind: 'commit',
        journal: first,
        cursor: first.cursor(),
        rows: [expect.objectContaining({ kind: 'item' })]
      })
      const cursor = first.cursor()
      rig.host.publishWorkChanged(id)
      const delivery = rig.host['clientDelivery']
      delivery.publishGenerationEnded(id, { restate: true })
      delivery.publishStatusAndSettlement(id)
      delivery.publishRestored(id)
      expect(events.slice(-4).map((e) => e.kind)).toEqual([
        'operational',
        'operational',
        'operational',
        'reset'
      ])
      expect(events.at(-1)).toMatchObject({ kind: 'reset', cursor })
      await rig.stop()
      expect(events.filter((event) => event.kind === 'operational').length).toBeGreaterThan(1)
      await rig.host.close(id, 'evict')
      expect(events.some((event) => event.kind === 'detach' && event.source === null)).toBe(true)
      const reopened = await rig.host.journalSnapshot(id)
      expect(reopened.items).toContainEqual(
        expect.objectContaining({ body: { kind: 'status', text: 'zero display readers' } })
      )
      const second = sessions.get(id)!.journal
      expect(second).not.toBe(first)
      const oldEvents = events.length
      // Old journal is closed and its slots are detached.
      first.stopMarks.settled({ settling: true }, 'old')
      expect(events).toHaveLength(oldEvents)
      await second.replaceEpochItems('handle_forked', 1, [])
      expect(events.at(-1)?.kind).toBe('reset')
      const plain: Map<string, StructuredAgentSessionHostSession> = sessions
      plain.clear()
      expect(events.at(-1)).toMatchObject({ kind: 'detach', journal: null })
      await rig.host.journalSnapshot(id)
      expect(rig.starts).toHaveBeenCalledTimes(started)
      expect(rig.dispatch).toHaveBeenCalledTimes(dispatched)
      rig.host.stopDelivery()
      expect(events.at(-1)?.kind).toBe('end')
      const late = vi.fn()
      const lateRelease = rig.host.observeConversationPublications(id, {
        next: late,
        error: vi.fn()
      })
      expect(late).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'end' }))
      lateRelease()
      release()
      release()
    } finally {
      release()
      await rig.dispose()
    }
  })
})
