/**
 * What one transaction costs as the store grows. These count calls and bytes; they show which work
 * left each path, not that a transaction is constant-time: it still reads and hashes the whole file.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeCrypto from 'node:crypto'
import type * as DurableFileWrite from '../durable-file-write'
import type * as AgentSessionRecordModule from '../../shared/agent-session-record'
import type * as StoreSerialization from './agent-session-store-serialization'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { AgentSessionRecordStore } from './agent-session-record-store'
import {
  AGENT_SESSION_STORE_SCHEMA_VERSION,
  agentSessionStorePath,
  saveAgentSessionStore
} from './agent-session-record-store-file'
import { AgentSessionTabTable } from './agent-session-tab-table'

const counts = vi.hoisted(() => ({
  validated: 0,
  serialized: 0,
  hashedBytes: 0,
  failNextPublish: false
}))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  const createHash: typeof actual.createHash = (algorithm, options) => {
    const hash = actual.createHash(algorithm, options)
    const counted: NodeCrypto.Hash = new Proxy(hash, {
      get: (target, property) => {
        if (property === 'update') {
          return (data: string | NodeJS.ArrayBufferView) => {
            counts.hashedBytes += Buffer.byteLength(data)
            target.update(data)
            return counted
          }
        }
        const value: unknown = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    return counted
  }
  return { ...actual, default: { ...actual, createHash }, createHash }
})

vi.mock('../../shared/agent-session-record', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSessionRecordModule>()
  return {
    ...actual,
    isPersistedAgentSessionRecord: (value: unknown) => {
      counts.validated += 1
      return actual.isPersistedAgentSessionRecord(value)
    }
  }
})

vi.mock('./agent-session-store-serialization', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreSerialization>()
  return {
    ...actual,
    serializeAgentSessionStoreState: (
      ...args: Parameters<typeof actual.serializeAgentSessionStoreState>
    ) => {
      counts.serialized += 1
      return actual.serializeAgentSessionStoreState(...args)
    }
  }
})

vi.mock('../durable-file-write', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableFileWrite>()
  return {
    ...actual,
    renameDurable: async (tmpPath: string, finalPath: string) => {
      if (counts.failNextPublish) {
        counts.failNextPublish = false
        throw new Error('simulated death before primary publish')
      }
      return actual.renameDurable(tmpPath, finalPath)
    }
  }
})

let root: string
let storePath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-store-transaction-cost-'))
  storePath = agentSessionStorePath(root)
})

afterEach(async () => {
  counts.failNextPublish = false
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

const sessionId = (index: number): string => `session-${String(index).padStart(6, '0')}`

/** A store of `size` live chats, each with a tab, written directly rather than one transaction each. */
async function openStoreOf(size: number): Promise<AgentSessionRecordStore> {
  const records = new Map(
    Array.from({ length: size }, (_, index) => {
      const record = agentSessionRecordFixture(
        agentSessionLeaseFixture({ sessionId: sessionId(index) })
      )
      return [record.sessionId, record] as const
    })
  )
  const sessionTabs = new AgentSessionTabTable()
  for (const id of records.keys()) {
    sessionTabs.show(id)
  }
  await saveAgentSessionStore(
    storePath,
    {
      schemaVersion: AGENT_SESSION_STORE_SCHEMA_VERSION,
      hostId: 'local',
      records,
      operations: new Map(),
      retiredClaimKeys: [],
      unreadableRecords: new Map(),
      sessionTabs
    },
    { primaryStatus: 'unusable-or-absent' }
  )
  return AgentSessionRecordStore.open({ directory: root, hostId: 'local' })
}

type Cost = { storeParses: number; validated: number; serialized: number; hashedBytes: number }

/** Store-file parses are counted at `JSON.parse`, the first step of every one. */
async function measure(run: () => Promise<unknown>): Promise<Cost> {
  counts.validated = 0
  counts.serialized = 0
  counts.hashedBytes = 0
  const parse = vi.spyOn(JSON, 'parse')
  try {
    await run()
  } finally {
    parse.mockRestore()
  }
  const storeParses = parse.mock.calls.filter(
    ([text]) => typeof text === 'string' && text.includes('"records"')
  ).length
  return {
    storeParses,
    validated: counts.validated,
    serialized: counts.serialized,
    hashedBytes: counts.hashedBytes
  }
}

describe('transaction cost', () => {
  it('a transaction that changes nothing parses, validates and serializes nothing', async () => {
    const store = await openStoreOf(100)
    const size = (await stat(storePath)).size

    // Already visible: the startup restore makes exactly this call once per chat.
    const cost = await measure(() => store.setSessionTabVisibility(sessionId(3), true))

    expect(cost).toEqual({ storeParses: 0, validated: 0, serialized: 0, hashedBytes: size })
  })

  it('a writing transaction serializes once and validates only the row it changed', async () => {
    const store = await openStoreOf(100)

    const cost = await measure(() => store.setConversationName(sessionId(3), 'renamed'))

    expect(cost.storeParses).toBe(0)
    expect(cost.serialized).toBe(1)
    expect(cost.validated).toBe(1)
    expect(
      JSON.parse(await readFile(storePath, 'utf-8')).records[sessionId(3)].conversationName
    ).toBe('renamed')
  })

  it('makes the same calls at 100 and 1000 chats; only the bytes hashed grow', async () => {
    const costAt = async (size: number): Promise<{ noOp: Cost; write: Cost }> => {
      await rm(root, { recursive: true, force: true })
      const store = await openStoreOf(size)
      return {
        noOp: await measure(() => store.setSessionTabVisibility(sessionId(1), true)),
        write: await measure(() => store.setConversationName(sessionId(1), 'renamed'))
      }
    }
    const small = await costAt(100)
    const large = await costAt(1000)

    expect({ ...large.noOp, hashedBytes: 0 }).toEqual({ ...small.noOp, hashedBytes: 0 })
    expect({ ...large.write, hashedBytes: 0 }).toEqual({ ...small.write, hashedBytes: 0 })
    expect(large.noOp.hashedBytes).toBeGreaterThan(small.noOp.hashedBytes * 5)
  })

  it('a failed publish keeps the hash of the unchanged primary, so the next refresh still skips the parse', async () => {
    const store = await openStoreOf(10)
    counts.failNextPublish = true
    await expect(store.setConversationName(sessionId(1), 'lost')).rejects.toThrow(
      'simulated death before primary publish'
    )

    const cost = await measure(() => store.setSessionTabVisibility(sessionId(1), true))

    expect(cost.storeParses).toBe(0)
    expect(cost.validated).toBe(0)
  })
})
