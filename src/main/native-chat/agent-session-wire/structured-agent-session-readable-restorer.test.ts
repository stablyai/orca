import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'

const { restoreOnRestart } = vi.hoisted(() => ({ restoreOnRestart: vi.fn() }))

vi.mock('./structured-agent-session-restart-restore', () => ({
  restoreStructuredAgentSessionsOnRestart: restoreOnRestart
}))

import { StructuredAgentSessionReadableRestorer } from './structured-agent-session-readable-restorer'

// The restore pool is mocked; the host database only fills the deps' shape.
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
    const records = ['background-a', 'visible-b', 'visible-a', 'background-b'].map(
      (sessionId) => ({ sessionId }) as AgentSessionRecord
    )
    const restorer = new StructuredAgentSessionReadableRestorer({
      openDeps: {
        store: { getRecord: () => null, listRecords: () => records },
        journalDatabase: openTestJournalHostDatabase(stateDirectory),
        adapter: {}
      },
      supportsRecord: () => true,
      reconcile: async () => null,
      resolveRecovery: async () => undefined,
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
