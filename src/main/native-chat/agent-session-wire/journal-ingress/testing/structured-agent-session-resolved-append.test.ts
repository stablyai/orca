import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { openAgentSessionJournal } from '../../../agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../structured-agent-session-event-sink'

import type { StructuredAgentSessionEventTarget } from '../structured-agent-session-event-sink'
import type { StructuredAgentSessionRevisionResolver } from '../structured-agent-session-journal-views'
import { estimateStructuredAgentSessionItemBytes } from '../structured-agent-session-event-sink-estimate'
import { testEventSinkLogging } from '../../host/testing/structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

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
  journal = await openAgentSessionJournal({
    database: openTestJournalHostDatabase(root),
    identity: {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      hostId: 'host-1',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    }
  })
})

afterEach(async () => {
  await journal.close()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

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
    expect(deferred.state().queuedOperations).toBe(3)
    // Bind within a queued read; early resolution would miss the preceding revisions.
    await journal.readInOrder(() => deferred.bind(journalTarget()))
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    expect(rowText()).toBe('abc')
  })
})
