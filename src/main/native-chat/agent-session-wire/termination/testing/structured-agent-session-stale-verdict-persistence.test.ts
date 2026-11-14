import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import '../structured-agent-session-dead-generation-settlement'
import { settleStaleStructuredAgentSessionState } from '../structured-agent-session-stale-state-settlement'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

import {
  PROVEN,
  RUNNING_IDENTITY,
  THREAD,
  turnScopeOf
} from './structured-agent-session-stale-verdict-contract-test-fixture'

it('adds one row for a death however many attempts its settle takes to write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-stale-session-'))
  const journals = createTrackedJournalOpener({ legacyInputs: true })
  let now = 100
  try {
    const journal = await journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: codexProviderHandle(THREAD)
      },
      stateDirectory: root,
      now: () => now
    })
    for (let index = 0; index < 399; index++) {
      const turnId = `turn-${index}`
      await journal.appendItem(
        { ...RUNNING_IDENTITY, turnId },
        { kind: 'turn', turnId, state: 'running', startedAt: 100 },
        { fence: 1, turnScope: turnScopeOf({ ...RUNNING_IDENTITY, turnId }) }
      )
    }
    now = 9_000
    const settle = () =>
      settleStaleStructuredAgentSessionState({
        journal,
        sessionId: 'session-1',
        fence: 2,
        acquisitionGeneration: null,
        deathEvidence: PROVEN
      })
    const turns = () =>
      journal.snapshot().items.flatMap((item) => readAgentJournalTurn(item.body) ?? [])
    const statusRows = () => journal.snapshot().items.filter((item) => item.body.kind === 'status')
    const database = openTestJournalHostDatabase(root)
    const cursor = journal.cursor()
    database.db.exec(`CREATE TEMP TRIGGER reject_later_stale_settlement
      BEFORE INSERT ON journal_rows
      WHEN NEW.session_id = 'session-1' AND NEW.seq > ${cursor.sequence + 1}
        AND json_extract(NEW.row_json, '$.recovered') = 1
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`)

    await expect(settle()).rejects.toThrow('disk full')
    database.db.exec('DROP TRIGGER reject_later_stale_settlement')
    expect(journal.cursor()).toEqual(cursor)
    expect(turns().filter((turn) => turn.state === 'running')).toHaveLength(399)
    expect(statusRows()).toHaveLength(0)

    await settle()
    expect(turns().filter((turn) => turn.state !== 'interrupted')).toEqual([])
    expect(statusRows()).toHaveLength(1)
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
