import { closeTestJournalHostDatabases } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session/lifecycle/agent-session-death-evidence'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import type { AgentSessionRecordStore } from './records/agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './records/agent-session-record-store-test-harness'

const SESSION = 'session-alpha-1'
const LAST_RENEWED_AT = 30_000

let directory: string

async function seed(deathEvidence: AgentSessionDeathEvidence | null): Promise<void> {
  const lease =
    deathEvidence === null
      ? agentSessionLeaseFixture()
      : agentSessionLeaseFixture({
          ownerProcess: null,
          reservedSpawnToken: null,
          claimStatus: 'released',
          deathEvidence
        })
  await seedTestAgentSessionRecordStore(directory, { records: [agentSessionRecordFixture(lease)] })
}

function open(): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(directory)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-death-evidence-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

describe('death evidence on disk', () => {
  it('records the last renewal before the crash and reads it back after another restart', async () => {
    await seed(null)
    const crashed = await open()
    await crashed.reconcileOnRestart({
      probe: async () => ({ outcome: 'pid-absent' }),
      now: 90_000
    })
    const evidence = {
      kind: 'pid-absent',
      detail: 'recorded pid absent on host',
      observedAt: 90_000,
      ownerFence: 7,
      lastProvenAliveAt: LAST_RENEWED_AT
    }
    expect(crashed.getRecord(SESSION)?.lease.deathEvidence).toEqual(evidence)
    expect((await open()).getRecord(SESSION)?.lease.deathEvidence).toEqual(evidence)
  })
})
