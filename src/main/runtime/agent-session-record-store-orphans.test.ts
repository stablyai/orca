import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type {
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { setStoredAgentSessionHandoffStage } from './agent-session-handoff-record-transitions'
import {
  AGENT_SESSION_CLAIM_KEY_RETENTION_MS,
  AgentSessionRecordStore
} from './agent-session-record-store'
import {
  AGENT_SESSION_STORE_FILE_NAME,
  agentSessionStorePath
} from './agent-session-record-store-file'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const BAD_OP_STORE = '{"schemaVersion":0,"hostId":"","records":{},"operations":{"x":0}}'
const BAD_KEY_STORE =
  '{"schemaVersion":1,"hostId":"","records":{},"operations":{},"retiredClaimKeys":[0]}'
const NOW = 1_800_000_000_000

const NATIVE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}
const WSL: AgentSessionExecutionLocation = { ...NATIVE, wslDistro: 'Ubuntu-22.04' }
const SSH: AgentSessionExecutionLocation = { ...NATIVE, executionHostId: 'ssh:build-box' }
const FOLDER: AgentSessionExecutionLocation = {
  ...NATIVE,
  workspaceId: 'workspace-2',
  workspaceKind: 'folder'
}

const INDETERMINATE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }

let counter = 0

function operationId(now = NOW): string {
  counter += 1
  return `${now}-${String(counter)
    .padStart(32, '0')
    .replaceAll(/[^0-9a-f]/g, '0')}`
}

function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: 'session-alpha',
    location: NATIVE,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: INDETERMINATE,
    operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' },
    now: NOW,
    ...overrides
  }
}

function processIdentity(
  overrides: Partial<AgentSessionProcessIdentity> = {}
): AgentSessionProcessIdentity {
  return {
    hostId: 'local',
    pid: 4242,
    processStartTimeMs: 1_700_000_000_000,
    spawnToken: 'spawn-a',
    ...overrides
  }
}

function handleLink(
  overrides: Partial<AgentSessionProviderHandleLink> = {}
): AgentSessionProviderHandleLink {
  return {
    linkId: 'link-1',
    handle: { provider: 'claude', sessionId: 'provider-session-1', leafUuid: 'leaf-1' },
    origin: 'created',
    mintedAtFence: 1,
    observedAt: NOW,
    ...overrides
  }
}

let directory: string

async function open(hostId = 'local'): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory, hostId })
}

/** Reserve, observe the spawn, prove the handle — the full path to an admitted writer. */
async function establishOwner(
  store: AgentSessionRecordStore,
  overrides: Partial<AgentSessionReserveRequest> = {}
): Promise<AgentSessionRecord> {
  const reserved = await store.reserveOwner(reserveRequest(overrides))
  const fence = reserved.record.lease.runtimeFence
  const sessionId = reserved.record.sessionId
  await store.commitProcessIdentity({
    sessionId,
    fence,
    process: processIdentity({ spawnToken: reserved.record.lease.reservedSpawnToken ?? 'spawn-a' }),
    now: NOW
  })
  return store.proveOwner({
    sessionId,
    fence,
    link: handleLink({ mintedAtFence: fence }),
    now: NOW
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-store-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('host and workspace isolation', () => {
  it.each([
    ['WSL', WSL],
    ['SSH', SSH],
    ['another workspace', FOLDER],
    ['another workspace kind', { ...NATIVE, workspaceKind: 'folder' }]
  ] as const)('refuses to move one session id to %s', async (_name, location) => {
    const store = await open()
    await establishOwner(store)
    await expect(
      store.reserveOwner(
        reserveRequest({
          location,
          expectedFence: 1,
          probe: { outcome: 'pid-absent' },
          operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' }
        })
      )
    ).rejects.toThrow('agent_session_conflict')
  })

  it('keeps native, WSL, and SSH sessions in separate scopes', async () => {
    const store = await open()
    await establishOwner(store, { sessionId: '__proto__' })
    await establishOwner(store, { sessionId: 'session-wsl', location: WSL, spawnToken: 'spawn-b' })
    await establishOwner(store, { sessionId: 'session-ssh', location: SSH, spawnToken: 'spawn-c' })
    await establishOwner(store, {
      sessionId: 'session-folder',
      location: FOLDER,
      spawnToken: 'spawn-d'
    })

    expect(store.listByScope(NATIVE).map((record) => record.sessionId)).toEqual(['__proto__'])
    expect(store.listByScope(WSL).map((record) => record.sessionId)).toEqual(['session-wsl'])
    expect(store.listByScope(SSH).map((record) => record.sessionId)).toEqual(['session-ssh'])
    expect(store.listByScope(FOLDER).map((record) => record.sessionId)).toEqual(['session-folder'])
    expect((await open()).getRecord('__proto__')).not.toBeNull()
  })

  it('preserves the workspace kind so a folder workspace is never read back as a worktree', async () => {
    const first = await open()
    await establishOwner(first, { sessionId: 'session-folder', location: FOLDER })
    const reopened = await open()
    expect(reopened.getRecord('session-folder')?.location).toEqual(FOLDER)
  })
})

describe('orphans, claim keys, checkpoints, and unreadable rows', () => {
  it('calls a spawn token with no lease an orphan', async () => {
    const store = await open()
    await establishOwner(store)
    expect(store.listOrphanSpawnTokens(['spawn-a', 'spawn-z'])).toEqual(['spawn-z'])
  })

  it('keeps a retired claim key verifiable for the retention window', async () => {
    const store = await open()
    await store.retireClaimKey('key-1', NOW)
    expect(store.isClaimKeyVerifiable('key-1', NOW + AGENT_SESSION_CLAIM_KEY_RETENTION_MS)).toBe(
      true
    )
    expect(
      store.isClaimKeyVerifiable('key-1', NOW + AGENT_SESSION_CLAIM_KEY_RETENTION_MS + 1)
    ).toBe(false)
    expect(store.isClaimKeyVerifiable('key-unknown', NOW)).toBe(true)
  })

  it('refuses a journal checkpoint that moves backwards', async () => {
    const store = await open()
    await establishOwner(store)
    await store.setJournalCheckpoint({
      sessionId: 'session-alpha',
      fence: 1,
      checkpoint: { epoch: 2, sequence: 10 },
      now: NOW
    })
    await expect(
      store.setJournalCheckpoint({
        sessionId: 'session-alpha',
        fence: 1,
        checkpoint: { epoch: 2, sequence: 9 },
        now: NOW
      })
    ).rejects.toThrow('agent_session_checkpoint_stale')
    await expect(
      store.setJournalCheckpoint({
        sessionId: 'session-alpha',
        fence: 1,
        checkpoint: { epoch: 1, sequence: 999 },
        now: NOW
      })
    ).rejects.toThrow('agent_session_checkpoint_stale')
    const advanced = await store.setJournalCheckpoint({
      sessionId: 'session-alpha',
      fence: 1,
      checkpoint: { epoch: 3, sequence: 0 },
      now: NOW
    })
    expect(advanced.lease.journalCheckpoint).toEqual({ epoch: 3, sequence: 0 })
  })

  it('rejects a handoff stage change under a different operation id', async () => {
    const store = await open()
    await establishOwner(store)
    await setStoredAgentSessionHandoffStage(store, {
      sessionId: 'session-alpha',
      fence: 1,
      stage: 'preparing',
      handoffOperationId: 'op-1',
      now: NOW
    })
    await expect(
      setStoredAgentSessionHandoffStage(store, {
        sessionId: 'session-alpha',
        fence: 1,
        stage: 'old-owner-stopped',
        handoffOperationId: 'op-2',
        now: NOW
      })
    ).rejects.toThrow('agent_session_operation_conflict')
  })

  it.each([
    [
      'invalid checkpoint',
      (record: AgentSessionRecord) =>
        Object.assign(record.lease, { journalCheckpoint: { epoch: 'bad', sequence: 1 } })
    ],
    [
      'missing live proof',
      (record: AgentSessionRecord) => Object.assign(record.lease, { provenHandleLinkId: null })
    ]
  ])('quarantines a record with %s', async (_name, corrupt) => {
    const first = await open()
    await establishOwner(first)
    const filePath = agentSessionStorePath(directory)
    const raw = JSON.parse(await readFile(filePath, 'utf-8'))
    corrupt(raw.records['session-alpha'])
    await writeFile(filePath, JSON.stringify(raw))
    expect((await open()).isSessionUnreadable('session-alpha')).toBe(true)
  })

  it('recovers the previous committed state when the primary file is corrupt', async () => {
    const first = await open()
    await establishOwner(first)
    // A second commit leaves the first as the backup.
    await first.setJournalCheckpoint({
      sessionId: 'session-alpha',
      fence: 1,
      checkpoint: { epoch: 1, sequence: 1 },
      now: NOW
    })
    await writeFile(join(directory, AGENT_SESSION_STORE_FILE_NAME), '{ truncated')

    const reopened = await open()
    expect(reopened.recoveredFromBackup).toBe(true)
    expect(reopened.getRecord('session-alpha')?.lease.runtimeFence).toBe(1)

    // The next transaction completes. It used to reject forever: the latch that guarded against
    // the lost commit's fence had no exit, so a profile in this state could never write again.
    await expect(reopened.retireClaimKey('key-2', NOW)).resolves.not.toThrow()
    // Safety is kept by recording a FLOOR the next grant must clear, not by rewriting the current
    // fence: `live` means a handle proven at exactly that number, so moving it would invalidate the
    // record. The floor dominates the highest fence the lost commit could have granted (1 + 1).
    const recovered = reopened.getRecord('session-alpha')
    expect(recovered?.lease.runtimeFence).toBe(1)
    expect(recovered?.lease.minimumNextFence).toBe(3)
  })

  it.each([
    ['corrupt', ['{ truncated']],
    ['missing required collections', ['{"schemaVersion":1,"hostId":"local"}']],
    ['invalid operation row', [BAD_OP_STORE]],
    ['invalid retired key', [BAD_KEY_STORE]],
    ['corrupt in both committed copies', ['{ truncated', '{ also truncated']]
  ])('fails closed when the store is %s', async (_name, copies) => {
    const filePath = agentSessionStorePath(directory)
    await writeFile(filePath, copies[0])
    if (copies[1]) {
      await writeFile(`${filePath}.bak`, copies[1])
    }
    await expect(open()).rejects.toThrow('agent_session_store_corrupt')
  })

  it('refuses to write a store written by a newer schema', async () => {
    const filePath = agentSessionStorePath(directory)
    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 99, hostId: 'local', records: {}, operations: {} })
    )
    const store = await open()
    expect(store.readOnly).toBe(true)
    await expect(store.reserveOwner(reserveRequest())).rejects.toThrow(
      'agent_session_legacy_required'
    )
  })
})
