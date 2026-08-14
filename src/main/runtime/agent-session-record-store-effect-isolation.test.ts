import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const NOW = 1_800_000_000_000
const LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

let directory: string
let operations = 0

function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  operations += 1
  return {
    sessionId: 'session-alpha',
    location: LOCATION,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: `spawn-${operations}`,
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'indeterminate', reason: 'no answer' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-${operations.toString(16).padStart(32, '0')}`,
      fingerprint: `fp-${operations}`
    },
    now: NOW,
    ...overrides
  }
}

function writerRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return reserveRequest({
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    effectIsolation: 'local-structured-write',
    ...overrides
  })
}

beforeEach(async () => {
  operations = 0
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-effect-store-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('effect-isolated agent-session records', () => {
  it('refuses to widen an existing normal session into a writer', async () => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    await store.reserveOwner(reserveRequest())

    await expect(
      store.reserveOwner(writerRequest({ expectedFence: 1, probe: { outcome: 'pid-absent' } }))
    ).rejects.toThrow('agent_session_conflict')
  })

  it('persists writers as v2 so an older host quarantines rather than widens them', async () => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    const reserved = await store.reserveOwner(writerRequest())
    expect(reserved.record).toMatchObject({
      schemaVersion: 2,
      effectIsolation: 'local-structured-write'
    })

    const path = agentSessionStorePath(directory)
    const persisted = JSON.parse(await readFile(path, 'utf8'))
    expect(persisted.records['session-alpha'].schemaVersion).toBe(2)
    persisted.records['session-alpha'].schemaVersion = 1
    await writeFile(path, JSON.stringify(persisted))

    const downgraded = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    expect(downgraded.getRecord('session-alpha')).toBeNull()
    expect(downgraded.isSessionUnreadable('session-alpha')).toBe(true)
  })
})
