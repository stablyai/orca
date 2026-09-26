/**
 * A transaction re-parses the store file only when its bytes differ from the ones it last loaded or
 * wrote, so what it writes must already be what a load accepts, and nothing may be published before
 * it is durable.
 */

import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DurableFileWrite from '../durable-file-write'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { AgentSessionRecordStore } from './agent-session-record-store'
import {
  AGENT_SESSION_STORE_SCHEMA_VERSION,
  agentSessionStorePath,
  agentSessionStoreRevision,
  agentSessionStoreSerializedRevision,
  loadAgentSessionStore
} from './agent-session-record-store-file'

type PublishFault = {
  fail: boolean
  reached: (() => void) | null
  release: Promise<void> | null
}

const publish = vi.hoisted((): PublishFault => ({
  fail: false,
  reached: null,
  release: null
}))

vi.mock('../durable-file-write', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableFileWrite>()
  return {
    ...actual,
    renameDurable: async (tmpPath: string, finalPath: string) => {
      publish.reached?.()
      await publish.release
      if (publish.fail) {
        publish.fail = false
        throw new Error('simulated death before primary publish')
      }
      return actual.renameDurable(tmpPath, finalPath)
    }
  }
})

const NOW = 1_800_000_000_000
let root: string
let storePath: string
let operations = 0

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-store-exact-change-'))
  storePath = agentSessionStorePath(root)
})

afterEach(async () => {
  publish.fail = false
  publish.reached = null
  publish.release = null
  await rm(root, { recursive: true, force: true })
})

const openStore = (): Promise<AgentSessionRecordStore> =>
  AgentSessionRecordStore.open({ directory: root, hostId: 'local' })

function operationId(): string {
  operations += 1
  return `${NOW}-${operations.toString(16).padStart(32, '0')}`
}

async function reserve(store: AgentSessionRecordStore, sessionId: string): Promise<number> {
  const reserved = await store.reserveOwner({
    sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
    expectedFence: null,
    spawnToken: `spawn-${sessionId}`,
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: { callerKey: 'test', operationId: operationId(), fingerprint: sessionId },
    now: NOW
  })
  return reserved.record.lease.runtimeFence
}

/** Reserve, observe the spawn, prove the handle: the only path to a `live` lease. */
async function makeLive(store: AgentSessionRecordStore, sessionId: string): Promise<void> {
  const fence = await reserve(store, sessionId)
  await store.commitProcessIdentity({
    sessionId,
    fence,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: NOW,
      spawnToken: `spawn-${sessionId}`
    },
    now: NOW
  })
  await store.proveOwner({
    sessionId,
    fence,
    link: {
      linkId: `link-${sessionId}`,
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW,
      handle: { provider: 'codex', threadId: `thread-${sessionId}` }
    },
    now: NOW
  })
}

/** A live lease whose head link is not the one its owner proved: a load quarantines it. */
const unprovenHead = (record: AgentSessionRecord): AgentSessionRecord => ({
  ...record,
  lease: { ...record.lease, provenHandleLinkId: 'link-never-proved' }
})

async function diskRoundTrips(): Promise<boolean> {
  const written = await readFile(storePath, 'utf-8')
  const loaded = await loadAgentSessionStore(storePath, 'local')
  return (
    agentSessionStoreRevision(loaded.state) ===
    agentSessionStoreSerializedRevision(AGENT_SESSION_STORE_SCHEMA_VERSION, written)
  )
}

/** Deterministic, so a failure names the exact step that broke the property. */
function* seededSteps(seed: number, count: number): Generator<number> {
  let value = seed
  for (let step = 0; step < count; step++) {
    value = (value * 1_103_515_245 + 12_345) % 2_147_483_648
    yield value
  }
}

describe('what a transaction writes is exactly what a load reads back', () => {
  it('holds for every state a committed transaction leaves, and refuses the rest', async () => {
    // All-digit ids reorder as integer keys in the written object; both kinds must round-trip.
    const sessionIds = ['12345678', '00000042', 'session-alpha', 'session-beta', '98765432']
    const store = await openStore()
    const live = new Set<string>()
    let refused = 0
    for (const value of seededSteps(7, 60)) {
      const sessionId = sessionIds[value % sessionIds.length]
      const before = await readFile(storePath, 'utf-8').catch(() => null)
      const step = (value >> 4) % 7
      let committed = true
      try {
        if (step === 0 || !live.has(sessionId)) {
          if (!live.has(sessionId)) {
            await makeLive(store, sessionId)
            live.add(sessionId)
          }
        } else if (step === 1) {
          await store.setSessionTabVisibility(sessionId, (value & 1) === 0)
        } else if (step === 2) {
          await store.setConversationName(sessionId, `chat ${value % 97}`)
        } else if (step === 3) {
          await store.retireClaimKey(`key-${value % 5}`, NOW + (value % 1000))
        } else if (step === 4) {
          await store.transitionHandoff(sessionId, unprovenHead)
        } else if (step === 5) {
          await store.setSessionTabVisibility(sessionId, true, 'tab:not-a-host-tab')
        } else {
          await store.transitionHandoff(sessionId, (record) => ({
            ...record,
            sessionId: 'session-elsewhere'
          }))
        }
      } catch (error) {
        expect(error).toEqual(new Error('agent_session_store_write_invalid'))
        committed = false
        refused += 1
      }
      if (!committed) {
        expect(await readFile(storePath, 'utf-8')).toBe(before)
      }
      expect(await diskRoundTrips(), `step ${step} on ${sessionId}`).toBe(true)
    }
    expect(refused).toBeGreaterThan(0)
  })

  it('refuses a live lease whose head link is not the proven one, leaving memory and disk alone', async () => {
    const store = await openStore()
    await makeLive(store, 'session-alpha')
    const record = store.getRecord('session-alpha')
    const bytes = await readFile(storePath, 'utf-8')

    await expect(store.transitionHandoff('session-alpha', unprovenHead)).rejects.toThrow(
      'agent_session_store_write_invalid'
    )

    expect(store.getRecord('session-alpha')).toBe(record)
    expect(await readFile(storePath, 'utf-8')).toBe(bytes)
    const reopened = await openStore()
    expect(reopened.isSessionUnreadable('session-alpha')).toBe(false)
    expect(reopened.getRecord('session-alpha')?.lease.provenHandleLinkId).toBe('link-session-alpha')
  })

  it('checks a row as written, so a member JSON drops cannot refuse the write', async () => {
    const store = await openStore()
    await makeLive(store, 'session-alpha')
    const options: Record<string, string> = { model: 'gpt-5' }
    // Enumerable but undefined: an in-memory check sees it, the written file has no such key.
    Object.defineProperty(options, 'effort', { value: undefined, enumerable: true })
    const fence = store.getRecord('session-alpha')?.lease.runtimeFence ?? -1

    await store.replaceSessionOptions({ sessionId: 'session-alpha', fence, options, now: NOW })

    const reopened = await openStore()
    expect(reopened.isSessionUnreadable('session-alpha')).toBe(false)
    expect(reopened.getRecord('session-alpha')?.options).toStrictEqual({ model: 'gpt-5' })
    expect(await diskRoundTrips()).toBe(true)
  })
})

describe('changes another writer made', () => {
  it('are adopted by the next transaction', async () => {
    const first = await openStore()
    await reserve(first, 'session-alpha')
    await first.setSessionTabVisibility('session-alpha', true)
    const second = await openStore()
    await reserve(second, 'session-beta')
    expect(first.getRecord('session-beta')).toBeNull()

    // Already visible: this transaction changes nothing, and only its refresh can see the write.
    await first.setSessionTabVisibility('session-alpha', true)

    expect(first.getRecord('session-beta')).not.toBeNull()
    expect(first.getRecord('session-alpha')?.lease.unreconciled).toBe(true)
  })

  it('leave an equal file that is only formatted differently unadopted', async () => {
    const store = await openStore()
    await reserve(store, 'session-alpha')
    await store.setSessionTabVisibility('session-alpha', true)
    const record = store.getRecord('session-alpha')
    expect(record?.lease.unreconciled).toBe(false)
    const text = await readFile(storePath, 'utf-8')
    await writeFile(storePath, JSON.stringify(JSON.parse(text), null, 2), 'utf-8')

    await store.setSessionTabVisibility('session-alpha', true)

    // Adoption would have replaced the record and marked its lease unreconciled.
    expect(store.getRecord('session-alpha')).toBe(record)
  })
})

describe('a primary whose rows were salvaged from the backup', () => {
  /** The primary quarantines `session-alpha`; the backup still holds a valid copy. */
  async function seedSalvageableRow(): Promise<void> {
    const seed = await openStore()
    await reserve(seed, 'session-alpha')
    await reserve(seed, 'session-beta')
    const file = JSON.parse(await readFile(storePath, 'utf-8'))
    const raw = { ...file.records['session-alpha'], lease: 'unreadable by this build' }
    file.unusableRecords['session-alpha'] = { reason: 'current_shape_invalid', raw }
    delete file.records['session-alpha']
    await writeFile(storePath, JSON.stringify(file), 'utf-8')
  }

  it('re-derives from both files until this store writes', async () => {
    await seedSalvageableRow()
    const store = await openStore()
    expect(store.getRecord('session-alpha')).not.toBeNull()
    // A peer that died after copying the primary aside, before publishing: the primary is
    // byte-identical, but the backup no longer holds the row the load salvaged.
    await copyFile(storePath, `${storePath}.bak`)

    await store.setSessionTabVisibility('session-beta', false)

    expect(store.getRecord('session-alpha')).toBeNull()
  })

  it('stops depending on the backup once the salvaged row is written', async () => {
    await seedSalvageableRow()
    const store = await openStore()
    await store.setConversationName('session-alpha', 'salvaged')
    await copyFile(storePath, `${storePath}.bak`)
    const parse = vi.spyOn(JSON, 'parse')

    await store.setSessionTabVisibility('session-beta', false)

    // Its own write is the exact primary again, so the refresh no longer re-reads either file.
    const storeParses = parse.mock.calls.filter(([text]) => text.includes('"records"')).length
    parse.mockRestore()
    expect(storeParses).toBe(0)
    expect(store.getRecord('session-alpha')?.conversationName).toBe('salvaged')
    expect((await openStore()).getRecord('session-alpha')?.conversationName).toBe('salvaged')
  })
})

describe('a save that fails after writing part of the commit', () => {
  it('keeps memory and the primary on the previous state, and the next transaction is correct', async () => {
    const store = await openStore()
    await reserve(store, 'session-alpha')
    await reserve(store, 'session-beta')
    const record = store.getRecord('session-alpha')
    const bytes = await readFile(storePath, 'utf-8')

    publish.fail = true
    await expect(store.setConversationName('session-alpha', 'lost')).rejects.toThrow(
      'simulated death before primary publish'
    )

    expect(store.getRecord('session-alpha')).toBe(record)
    expect(await readFile(storePath, 'utf-8')).toBe(bytes)
    // The copy step already ran: the backup now holds the unchanged primary.
    expect(await readFile(`${storePath}.bak`, 'utf-8')).toBe(bytes)
    await store.setConversationName('session-beta', 'kept')
    const reopened = await openStore()
    expect(reopened.getRecord('session-alpha')?.conversationName).toBeUndefined()
    expect(reopened.getRecord('session-beta')?.conversationName).toBe('kept')
    expect(await diskRoundTrips()).toBe(true)
  })

  it('never shows the change to a reader while the save is pending', async () => {
    const store = await openStore()
    await reserve(store, 'session-alpha')
    const record = store.getRecord('session-alpha')
    let release!: () => void
    publish.release = new Promise<void>((resolve) => {
      release = resolve
    })
    const reached = new Promise<void>((resolve) => {
      publish.reached = resolve
    })
    publish.fail = true

    const pending = store.setConversationName('session-alpha', 'phantom')
    await reached
    expect(store.getRecord('session-alpha')).toBe(record)
    expect(store.listRecords().map((listed) => listed.conversationName)).toEqual([undefined])
    release()

    await expect(pending).rejects.toThrow('simulated death before primary publish')
    expect(store.getRecord('session-alpha')).toBe(record)
  })
})
