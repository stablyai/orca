// Attribute death only to recorded prior runtimes of this build; unknown owners retain generic guidance.

import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionLease } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import {
  agentSessionRuntimeIncarnation,
  beginAgentSessionRuntimeIncarnationForTest
} from './agent-session-runtime-attribution'
import {
  beginAgentSessionRuntimeRecord,
  recordAgentSessionRuntimeEnd
} from './agent-session-runtime-end-record'

const SESSION = 'session-alpha-1'
const OWNER = {
  hostId: 'local',
  pid: 4242,
  processStartTimeMs: 1_700_000_000_000,
  spawnToken: 'spawn-owner'
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-runtime-attribution-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

async function seedHeldBy(runtime: string | null, lease: Partial<AgentSessionLease> = {}) {
  await seedTestAgentSessionRecordStore(directory, {
    records: [
      agentSessionRecordFixture(
        agentSessionLeaseFixture({
          ownerProcess: runtime ? { ...OWNER, runtime } : OWNER,
          unreconciled: true,
          ...lease
        })
      )
    ]
  })
}

function recorded(runtime: string, end?: 'quit' | 'update') {
  beginAgentSessionRuntimeRecord(directory, runtime, 1_000)
  if (end) {
    recordAgentSessionRuntimeEnd(end, 50_000)
  }
}

async function restartEvidence() {
  const store = await openTestAgentSessionRecordStore(directory)
  await store.reconcileOnRestart({ probe: async () => ({ outcome: 'pid-absent' }), now: 90_000 })
  return store.getRecord(SESSION)?.lease.deathEvidence ?? null
}

describe("an agent that died with Orca's previous runtime", () => {
  it('died in a crash when that runtime started and never ended', async () => {
    await seedHeldBy('runtime-a')
    recorded('runtime-a')
    expect(await restartEvidence()).toMatchObject({ kind: 'pid-absent', runtimeEnd: 'crash' })
  })

  it.each(['update', 'quit'] as const)(
    'died with the %s that runtime began, when the quit did not finish',
    async (trigger) => {
      await seedHeldBy('runtime-a')
      recorded('runtime-a', trigger)
      expect(await restartEvidence()).toMatchObject({ runtimeEnd: trigger })
    }
  )

  it("is never told by another runtime's end", async () => {
    await seedHeldBy('runtime-b')
    recorded('runtime-b')
    recorded('runtime-a', 'update')
    expect(await restartEvidence()).toMatchObject({ runtimeEnd: 'crash' })
  })

  it('names no cause when that runtime left no record', async () => {
    await seedHeldBy('runtime-a')
    recorded('runtime-b', 'quit')
    expect(await restartEvidence()).not.toHaveProperty('runtimeEnd')
  })

  it("names no cause when that runtime's record cannot be read", async () => {
    await seedHeldBy('runtime-a')
    await mkdir(join(directory, 'agent-session-runtimes'), { recursive: true })
    await writeFile(join(directory, 'agent-session-runtimes', 'runtime-a.json'), '{not json')
    expect(await restartEvidence()).not.toHaveProperty('runtimeEnd')
  })

  it('names no cause for an owner an older build recorded', async () => {
    await seedHeldBy(null)
    expect(await restartEvidence()).not.toHaveProperty('runtimeEnd')
  })

  it("names no cause for a terminal's agent", async () => {
    await seedHeldBy('runtime-a', { claimStatus: 'conflicted' })
    expect(await restartEvidence()).not.toHaveProperty('runtimeEnd')
  })

  it('is told once a survivor that outlived the runtime is stopped and proven gone', async () => {
    await seedHeldBy('runtime-a')
    recorded('runtime-a')
    const store = await openTestAgentSessionRecordStore(directory)
    // Surviving owners stay in recovery until their stop is proven.
    await store.reconcileOnRestart({
      probe: async () => ({ outcome: 'identity-matched', matchedOn: ['spawn-token'] }),
      now: 90_000
    })
    expect(store.getRecord(SESSION)?.lease.handoffStage).toBe('recovering')

    await store.evictProvenDeadOwner({
      sessionId: SESSION,
      expectedFence: 7,
      probe: { outcome: 'pid-absent' },
      now: 95_000
    })

    expect(store.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({ runtimeEnd: 'crash' })
  })
})

describe('an agent this runtime ran', () => {
  it("becomes an earlier runtime's after a relaunch", async () => {
    await seedHeldBy(agentSessionRuntimeIncarnation())
    await openTestAgentSessionRecordStore(directory)
    beginAgentSessionRuntimeIncarnationForTest()
    expect(await restartEvidence()).toMatchObject({ runtimeEnd: 'crash' })
  })
})
