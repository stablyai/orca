import { openTestAgentSessionDatabase } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnItem
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalItemIdentity } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionJournal } from '../../../agent-session-journal/journal-store'
import { closeTestJournalHostDatabases } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { openAgentSessionJournal } from '../../../agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../structured-agent-session-event-sink'

import type { StructuredAgentSessionEventTarget } from '../structured-agent-session-event-sink'
import { testEventSinkLogging } from '../../host/testing/structured-agent-session-logger.test-fixture'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

const ROW: AgentJournalItemIdentity = { provider: 'orca', clientMessageId: 'turn-row' }
const RUNNING: AgentJournalTurnItem = {
  kind: 'turn',
  turnId: 'turn-1',
  state: 'running',
  userItemId: 'orca:submission:cmd-1',
  startedAt: 1
}

let root = ''
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-resolved-append-'))
  journal = await openAgentSessionJournal({
    database: await openTestAgentSessionDatabase(root),
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

const row = async () => await journal.reads.itemBody(agentJournalItemKey(ROW))

describe('resolved revisions', () => {
  it('resolves each queued revision against the row as the journal holds it when it runs', async () => {
    await journal.appendItem(ROW, RUNNING, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    const options = { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    const window = { tokens: 200_000, capturedAt: 2 }
    expect(
      deferred.sink.tryReviseResolvedItem?.(
        8_192,
        { kind: 'turn-row', target: { identity: ROW }, write: { contextUsage: { window } } },
        options
      )
    ).toEqual({ accepted: true })
    expect(
      deferred.sink.tryReviseResolvedItem?.(
        8_192,
        { kind: 'turn-claim', identity: ROW, providerTurnId: 'provider-turn-1' },
        options
      )
    ).toEqual({ accepted: true })
    // Bind within a queued read; resolving at admission would lose the earlier revision.
    await journal.readInOrder(() => deferred.bind(journalTarget()))
    await expect(deferred.drained()).resolves.toEqual({ ok: true })
    expect(await row()).toEqual({
      ...RUNNING,
      contextUsage: { window },
      providerTurnId: 'provider-turn-1'
    })
  })
})
