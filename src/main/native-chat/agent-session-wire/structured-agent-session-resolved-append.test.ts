import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openJournalOwingImport } from '../agent-session-journal/journal-owed-import-test-support'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget,
  type StructuredAgentSessionRevisionResolver
} from './structured-agent-session-event-sink'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'

const ROW: AgentJournalItemIdentity = { provider: 'orca', clientMessageId: 'row' }

const text = (value: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: value }]
})

function textOf(body: AgentJournalItemBody | undefined): string {
  const block = body?.kind === 'message' ? body.blocks[0] : undefined
  return block?.type === 'text' ? block.text : ''
}

let root = ''
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-resolved-append-'))
  // Its copy owed, so every write handed over waits in the queue: a resolver that read at submit
  // would read the row before the revisions ahead of it had landed.
  ;({ journal } = await openJournalOwingImport({
    stateDirectory: root,
    identity: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      hostId: 'host-1',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: 'thread-1' }
    }
  }))
})

afterEach(async () => {
  await journal.close()
  await rm(root, { recursive: true, force: true })
})

/** The real journal: each resolved write reads the fold at its own place in the write queue. */
function journalTarget(): StructuredAgentSessionEventTarget {
  return { journal, fence: 1, publish: vi.fn() }
}

const rowText = (): string => textOf(journal.itemBody(agentJournalItemKey(ROW)) ?? undefined)

const appendSuffix =
  (suffix: string): StructuredAgentSessionRevisionResolver =>
  (journal) => {
    let current: AgentJournalItemBody | undefined
    journal.visitItems((itemId, _sequence, body) => {
      if (itemId === agentJournalItemKey(ROW)) {
        current = body
      }
    })
    return { identity: ROW, body: text(`${textOf(current)}${suffix}`) }
  }

describe('resolved revisions', () => {
  it('reads the row as the journal holds it when each queued revision runs', async () => {
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    const bytes = estimateStructuredAgentSessionItemBytes(ROW, text('abc'))
    for (const suffix of ['a', 'b', 'c']) {
      expect(
        deferred.sink.tryReviseResolvedItem?.(bytes, appendSuffix(suffix), {
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      ).toEqual({
        accepted: true
      })
    }
    // Three revisions of one row stay three operations; none replaces another.
    expect(deferred.state().queuedOperations).toBe(3)
    deferred.bind(journalTarget())
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    expect(rowText()).toBe('abc')
  })

  it('skips a revision that resolves to nothing', async () => {
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.sink.tryReviseResolvedItem?.(1_000, () => null, {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const before = journal.cursor()
    deferred.bind(journalTarget())
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    expect(journal.cursor()).toEqual(before)
  })

  it('publishes a revision in the operation that writes it, within the same reservation', async () => {
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    const bytes = estimateStructuredAgentSessionItemBytes(ROW, text('a'))
    deferred.sink.tryReviseResolvedItemAndPublish?.(bytes, appendSuffix('a'), {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    deferred.sink.tryReviseResolvedItemAndPublish?.(bytes, () => null, {
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    const target = journalTarget()
    const published: string[] = []
    vi.mocked(target.publish).mockImplementation(() => published.push(rowText()))
    deferred.bind(target)
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    // Published once, after the append: the revision that resolves to nothing publishes nothing.
    expect(published).toEqual(['a'])
  })

  it('refuses a resolved write larger than the reservation it was admitted with', async () => {
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    const bytes = estimateStructuredAgentSessionItemBytes(ROW, text('a'))
    deferred.sink.tryReviseResolvedItem?.(
      bytes,
      () => ({
        identity: ROW,
        body: text('a'.repeat(64))
      }),
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    deferred.bind(journalTarget())
    await expect(deferred.drained()).resolves.toMatchObject({ ok: false })
    expect(journal.itemBody(agentJournalItemKey(ROW))).toBeNull()
  })
})
