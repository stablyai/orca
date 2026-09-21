import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { AgentSessionRecordStore } from './agent-session-record-store'
import {
  AGENT_SESSION_STORE_SCHEMA_VERSION,
  agentSessionStorePath
} from './agent-session-record-store-file'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const NOW = 1_800_000_000_000
const SESSION_ID = 'session-alpha-1'
let directory: string

function reserveRequest(): AgentSessionReserveRequest {
  return {
    sessionId: SESSION_ID,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/user/.codex' },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-new',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-00000000000000000000000000000001`,
      fingerprint: 'fp-1'
    },
    now: NOW
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-unsupported-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('unsupported agent session record schema', () => {
  it('quarantines without upgrading and keeps the session fail-closed', async () => {
    const filePath = agentSessionStorePath(directory)
    const unsupported = { ...agentSessionRecordFixture(), schemaVersion: 1 }
    const payload = JSON.stringify({
      schemaVersion: AGENT_SESSION_STORE_SCHEMA_VERSION,
      hostId: 'local',
      records: { [SESSION_ID]: unsupported },
      operations: {},
      retiredClaimKeys: [],
      unusableRecords: {}
    })
    await Promise.all([writeFile(filePath, payload), writeFile(`${filePath}.bak`, payload)])

    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })

    expect(store.getRecord(SESSION_ID)).toBeNull()
    expect(store.isSessionUnreadable(SESSION_ID)).toBe(true)
    await expect(store.reserveOwner(reserveRequest())).rejects.toThrow(
      'execution_owner_reconciling'
    )
    const persisted = JSON.parse(await readFile(filePath, 'utf-8'))
    expect(persisted.records).not.toHaveProperty(SESSION_ID)
    expect(persisted.unusableRecords[SESSION_ID]).toMatchObject({
      reason: 'unsupported_schema',
      raw: { schemaVersion: 1 }
    })
  })

  it('rejects an ad-hoc store schema without rewriting it', async () => {
    const filePath = agentSessionStorePath(directory)
    const payload = JSON.stringify({
      schemaVersion: 1,
      hostId: 'local',
      records: {},
      operations: {},
      retiredClaimKeys: [],
      unusableRecords: {}
    })
    await writeFile(filePath, payload)

    await expect(AgentSessionRecordStore.open({ directory, hostId: 'local' })).rejects.toThrow(
      'agent_session_store_corrupt'
    )
    await expect(readFile(filePath, 'utf-8')).resolves.toBe(payload)
  })
})
