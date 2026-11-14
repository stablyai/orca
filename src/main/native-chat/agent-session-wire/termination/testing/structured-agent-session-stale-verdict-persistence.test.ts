import { readTestJournalSnapshot } from '../../../agent-session-journal/journal-observation.test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { createTrackedJournalOpener } from '../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { withTestAgentSessionDatabase } from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import '../structured-agent-session-dead-generation-settlement'
import { settleStaleStructuredAgentSessionState } from '../structured-agent-session-stale-state-settlement'
import { codexProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

import {
  PROVEN,
  RUNNING_IDENTITY,
  THREAD,
  turnScopeOf
} from './structured-agent-session-stale-verdict-contract.test-fixture'

it('rolls back failed death settlement and saves one notice when retried', async () => {
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
    const turns = async () =>
      (await readTestJournalSnapshot(journal)).items.flatMap(
        (item) => readAgentJournalTurn(item.body) ?? []
      )
    const statusRows = async () =>
      (await readTestJournalSnapshot(journal)).items.filter((item) => item.body.kind === 'status')
    const cursor = journal.cursor()
    await withTestAgentSessionDatabase(root, (db) =>
      db.exec(`
      CREATE TRIGGER reject_later_stale_settlement BEFORE UPDATE OF payload_json ON journal_items
      WHEN NEW.session_id = 'session-1' AND NEW.provider_turn_id = 'turn-398'
      BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
    )

    await expect(settle()).rejects.toThrow('disk full')
    await withTestAgentSessionDatabase(root, (db) =>
      db.exec('DROP TRIGGER reject_later_stale_settlement')
    )
    expect(journal.cursor()).toEqual(cursor)
    expect((await turns()).filter((turn) => turn.state === 'running')).toHaveLength(399)
    expect(await statusRows()).toHaveLength(0)

    await settle()
    expect((await turns()).filter((turn) => turn.state !== 'interrupted')).toEqual([])
    expect(await statusRows()).toHaveLength(1)
  } finally {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  }
})
