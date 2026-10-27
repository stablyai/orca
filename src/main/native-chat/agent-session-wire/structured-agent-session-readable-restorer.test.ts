import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'

const { restoreOnRestart } = vi.hoisted(() => ({ restoreOnRestart: vi.fn() }))

vi.mock('./structured-agent-session-restart-restore', () => ({
  restoreStructuredAgentSessionsOnRestart: restoreOnRestart
}))

import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-readable-restorer-'))
afterAll(() => {
  closeTestJournalHostDatabases()
  rmSync(stateDirectory, { recursive: true, force: true })
})

describe('StructuredAgentSessionReadableRestorer', () => {
  beforeEach(() => {
    restoreOnRestart.mockReset().mockResolvedValue(undefined)
  })

  it('passes targeted records to the restore pool in visible-first order', async () => {
    const records = ['background-a', 'visible-b', 'visible-a', 'background-b'].map((sessionId) =>
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId }))
    )
    const restorer = new StructuredAgentSessionReadableRestorer({
      openDeps: {
        store: {
          getRecord: () => null,
          getConversation: () => null,
          listConversations: () => records.map(agentSessionConversationView),
          replacedRuntime: () => undefined
        },
        journalDatabase: openTestJournalHostDatabase(stateDirectory),
        logger: recordingStructuredAgentSessionLogger().logger
      },
      reconcileAll: async () => true,
      reconcile: async () => true,
      resolveRecovery: async () => true,
      serialize: async (_sessionId, task) => task(),
      hasSession: () => false,
      onReadable: () => undefined
    })

    await restorer.restore(['visible-a', 'visible-b', 'background-a', 'background-b'])

    expect(restoreOnRestart).toHaveBeenCalledOnce()
    expect(restoreOnRestart.mock.calls[0][0].records.map((record) => record.sessionId)).toEqual([
      'visible-a',
      'visible-b',
      'background-a',
      'background-b'
    ])
  })
})
