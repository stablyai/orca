// Read repair: a recoverable optional field must never cost the session its lease, options and
// provider-handle chain. Anything structural still quarantines the whole record.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath, loadAgentSessionStore } from './agent-session-record-store-file'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const NOW = 1_800_000_000_000
const SESSION = 'session-alpha'

let directory: string
let counter = 0

function operationId(): string {
  counter += 1
  return `${NOW}-${String(counter)
    .padStart(32, '0')
    .replaceAll(/[^0-9a-f]/g, '0')}`
}

const reserveRequest = (): AgentSessionReserveRequest => ({
  sessionId: SESSION,
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree'
  },
  provider: 'claude',
  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
  runtimeKind: 'native',
  expectedFence: null,
  spawnToken: 'spawn-a',
  claimKeyId: 'key-1',
  handoffOperationId: null,
  probe: { outcome: 'indeterminate', reason: 'no answer' },
  operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' },
  now: NOW
})

/** Reserve, observe the spawn, prove the handle, carry options — a fully furnished record. */
async function establishOwnedRecord(): Promise<AgentSessionRecord> {
  const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
  const reserved = await store.reserveOwner(reserveRequest())
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: reserved.record.lease.reservedSpawnToken ?? 'spawn-a'
    },
    now: NOW
  })
  return store.proveOwner({
    sessionId: SESSION,
    fence,
    link: {
      linkId: 'link-1',
      handle: { provider: 'claude', sessionId: 'provider-session-1', leafUuid: 'leaf-1' },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    options: { model: 'opus' },
    now: NOW
  })
}

/** Write a name the single writer would have normalized away, as a stale build could have left it. */
async function writeStoredName(name: unknown): Promise<void> {
  const filePath = agentSessionStorePath(directory)
  const raw = JSON.parse(await readFile(filePath, 'utf-8'))
  raw.records[SESSION].conversationName = name
  await writeFile(filePath, JSON.stringify(raw))
}

async function corruptStoredLease(): Promise<void> {
  const filePath = agentSessionStorePath(directory)
  const raw = JSON.parse(await readFile(filePath, 'utf-8'))
  raw.records[SESSION].lease.runtimeFence = 'not-a-number'
  await writeFile(filePath, JSON.stringify(raw))
}

const load = () => loadAgentSessionStore(agentSessionStorePath(directory), 'local')

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-session-read-repair-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('agent session record read repair', () => {
  it('repairs a noncanonical name instead of discarding the record around it', async () => {
    const owned = await establishOwnedRecord()
    await writeStoredName('Fix\nthe lease probe')

    const loaded = await load()

    const record = loaded.state.records.get(SESSION)
    expect(record?.conversationName).toBe('Fix the lease probe')
    expect(loaded.state.unreadableRecords.has(SESSION)).toBe(false)
    // The fields quarantine would have taken with it.
    expect(record?.lease).toMatchObject({ claimStatus: 'live', runtimeFence: 1 })
    expect(record?.options).toEqual({ model: 'opus' })
    expect(record?.providerHandleChain).toEqual(owned.providerHandleChain)
  })

  it('drops only the field when the stored name normalizes to nothing', async () => {
    await establishOwnedRecord()
    await writeStoredName('\u202E\u200B ')

    const loaded = await load()

    const record = loaded.state.records.get(SESSION)
    expect(record).toBeDefined()
    expect(record?.conversationName).toBeUndefined()
    expect(Object.hasOwn(record ?? {}, 'conversationName')).toBe(false)
    expect(record?.lease.claimStatus).toBe('live')
    expect(record?.options).toEqual({ model: 'opus' })
  })

  it('drops a name of the wrong type rather than the record', async () => {
    await establishOwnedRecord()
    await writeStoredName(42)

    const loaded = await load()

    expect(loaded.state.records.get(SESSION)?.conversationName).toBeUndefined()
    expect(loaded.state.unreadableRecords.has(SESSION)).toBe(false)
  })

  it('drops a null name rather than the record', async () => {
    await establishOwnedRecord()
    await writeStoredName(null)

    const loaded = await load()

    expect(loaded.state.records.get(SESSION)?.conversationName).toBeUndefined()
    expect(loaded.state.unreadableRecords.has(SESSION)).toBe(false)
  })

  it('still quarantines the whole record when the lease is structurally invalid', async () => {
    await establishOwnedRecord()
    await writeStoredName('Fix\nthe lease probe')
    await corruptStoredLease()
    // No committed copy may vouch for the session, or salvage would mask the quarantine.
    await rm(`${agentSessionStorePath(directory)}.bak`, { force: true })

    const loaded = await load()

    expect(loaded.state.records.has(SESSION)).toBe(false)
    expect(loaded.state.unreadableRecords.get(SESSION)?.reason).toBe('current_shape_invalid')
    // Quarantined bytes stay verbatim: repair must not edit the row it could not rescue.
    expect(loaded.state.unreadableRecords.get(SESSION)?.raw).toMatchObject({
      conversationName: 'Fix\nthe lease probe'
    })
  })

  it('leaves a canonical name alone and asks for no rewrite', async () => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    await store.reserveOwner(reserveRequest())
    await store.setConversationName(SESSION, 'Fix the lease probe')

    const loaded = await load()

    expect(loaded.state.records.get(SESSION)?.conversationName).toBe('Fix the lease probe')
    expect(loaded.needsRewrite).toBe(false)
  })

  it('marks the store for rewrite without touching the record business timestamp', async () => {
    const owned = await establishOwnedRecord()
    await writeStoredName('Fix\nthe lease probe')

    const loaded = await load()
    expect(loaded.needsRewrite).toBe(true)
    expect(loaded.state.records.get(SESSION)?.updatedAt).toBe(owned.updatedAt)

    // Opening the store persists that rewrite, so the next load has nothing left to repair.
    await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    const persisted = JSON.parse(await readFile(agentSessionStorePath(directory), 'utf-8'))
    expect(persisted.records[SESSION].conversationName).toBe('Fix the lease probe')
    expect(persisted.records[SESSION].updatedAt).toBe(owned.updatedAt)
    expect((await load()).needsRewrite).toBe(false)
  })
})
