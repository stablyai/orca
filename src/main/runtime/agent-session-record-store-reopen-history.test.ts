import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import {
  agentSessionProviderHandleKey,
  claudeProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'
import type {
  AgentSessionProviderHandle,
  AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore,
  storedTestAgentSessionRecord
} from './agent-session-record-store-test-harness'

const NOW = 1_800_000_000_000
const UNUSED: AgentSessionOwnerProbe = { outcome: 'reservation-unused' }
const LEGACY_CHAIN_LIMIT = 256

const acp = (nativeId: string): AgentSessionProviderHandle => ({
  transport: 'acp',
  agent: 'grok',
  nativeId
})

type Agent = Pick<AgentSessionReserveRequest, 'provider' | 'accountHome'>
const CLAUDE: Agent = {
  provider: 'claude',
  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' }
}
const GROK: Agent = {
  provider: 'grok',
  accountHome: { variable: 'GROK_HOME', path: '/home/dev/.grok' }
}

let directory: string
let operations = 0

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-reopen-history-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function request(agent: Agent, expectedFence: number | null, now: number) {
  operations += 1
  return {
    sessionId: 'session-alpha',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    ...agent,
    expectedFence,
    spawnToken: `spawn-${operations}`,
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: UNUSED,
    operation: {
      callerKey: 'client-1',
      operationId: `${now}-${String(operations).padStart(32, '0')}`,
      fingerprint: `fp-${operations}`
    },
    now
  } satisfies AgentSessionReserveRequest
}

/** One open of the chat: its owner exits, then a new process reserves, starts and proves `link`. */
async function reopen(
  store: AgentSessionRecordStore,
  agent: Agent,
  link: (fence: number) => Omit<AgentSessionProviderHandleLink, 'mintedAtFence' | 'observedAt'>
): Promise<AgentSessionRecord> {
  const now = NOW + operations
  const before = store.getRecord('session-alpha')
  if (before?.lease.claimStatus === 'live') {
    await store.evictProvenDeadOwner({
      sessionId: 'session-alpha',
      expectedFence: before.lease.runtimeFence,
      probe: { outcome: 'exit-observed' },
      now
    })
  }
  const reserved = await store.reserveOwner(
    request(agent, store.getRecord('session-alpha')?.lease.runtimeFence ?? null, now)
  )
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: 'session-alpha',
    fence,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: reserved.record.lease.reservedSpawnToken ?? 'spawn-a'
    },
    now
  })
  return store.proveOwner({
    sessionId: 'session-alpha',
    fence,
    link: { ...link(fence), mintedAtFence: fence, observedAt: now },
    now
  })
}

const claudeLink = (origin: 'created' | 'resumed') => (fence: number) => ({
  linkId: `claude-${fence}`,
  handle: claudeProviderHandle('provider-session-1', `leaf-${fence}`),
  origin
})

const grokLink =
  (nativeId: string, origin: 'created' | 'resumed', replaces?: string) => (fence: number) => ({
    linkId: `grok-${fence}`,
    handle: acp(nativeId),
    origin,
    ...(replaces
      ? {
          replaces: {
            key: agentSessionProviderHandleKey(acp(replaces)),
            reason: 'restore-failed',
            replacedAt: NOW
          }
        }
      : {})
  })

describe('reopening a chat never runs out of room', () => {
  it('reopens a chat more times than the old 256-link limit, and keeps one current link', async () => {
    const store = await openTestAgentSessionRecordStore(directory)
    await reopen(store, CLAUDE, claudeLink('created'))
    let record: AgentSessionRecord | undefined
    for (let open = 0; open < LEGACY_CHAIN_LIMIT + 44; open += 1) {
      record = await reopen(store, CLAUDE, claudeLink('resumed'))
    }
    expect(record?.providerHandleChain.map((link) => link.origin)).toEqual(['created', 'resumed'])
    expect(record?.lease.provenHandleLinkId).toBe(record?.providerHandleChain.at(-1)?.linkId)

    const reopened = await openTestAgentSessionRecordStore(directory)
    expect(reopened.getRecord('session-alpha')?.providerHandleChain).toEqual(
      record?.providerHandleChain
    )
  }, 60_000)

  it('reopens a chat an older build already filled to 256 links', async () => {
    const store = await openTestAgentSessionRecordStore(directory)
    const created = await reopen(store, CLAUDE, claudeLink('created'))
    await store.evictProvenDeadOwner({
      sessionId: 'session-alpha',
      expectedFence: created.lease.runtimeFence,
      probe: { outcome: 'exit-observed' },
      now: NOW
    })
    const head = created.providerHandleChain[0]
    const legacy = Array.from({ length: LEGACY_CHAIN_LIMIT - 1 }, (_value, index) => ({
      ...head,
      linkId: `legacy-${index}`,
      origin: 'resumed' as const,
      handle: claudeProviderHandle('provider-session-1', `legacy-leaf-${index}`)
    }))
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      const row = persisted.records['session-alpha']
      const full = { ...row, providerHandleChain: [...row.providerHandleChain] }
      full.providerHandleChain.push(
        ...storedTestAgentSessionRecord({ ...created, providerHandleChain: legacy })
          .providerHandleChain
      )
      persisted.records['session-alpha'] = full
    })

    const full = await openTestAgentSessionRecordStore(directory)
    expect(full.getRecord('session-alpha')?.providerHandleChain).toHaveLength(LEGACY_CHAIN_LIMIT)
    await full.reconcileOnRestart({ probe: async () => UNUSED, now: NOW })
    const resumed = await reopen(full, CLAUDE, claudeLink('resumed'))
    expect(resumed.providerHandleChain).toHaveLength(LEGACY_CHAIN_LIMIT)
    expect(resumed.providerHandleChain.at(-1)?.linkId).toBe(resumed.lease.provenHandleLinkId)
    expect(resumed.providerHandleChain.at(-2)?.linkId).toBe('legacy-253')
  })

  it('takes a fresh session after many reopens, then resumes it, keeping every switch', async () => {
    const store = await openTestAgentSessionRecordStore(directory)
    await reopen(store, GROK, grokLink('s-1', 'created'))
    for (let open = 0; open < LEGACY_CHAIN_LIMIT; open += 1) {
      await reopen(store, GROK, grokLink('s-1', 'resumed'))
    }
    await reopen(store, GROK, grokLink('s-2', 'created', 's-1'))
    for (let open = 0; open < 3; open += 1) {
      await reopen(store, GROK, grokLink('s-2', 'resumed'))
    }
    const record = await reopen(store, GROK, grokLink('s-3', 'created', 's-2'))
    const resumed = await reopen(store, GROK, grokLink('s-3', 'resumed'))

    expect(record.providerHandleChain.at(-1)?.replaces?.key).toBe(
      agentSessionProviderHandleKey(acp('s-2'))
    )
    expect(resumed.providerHandleChain.map((link) => [link.handle.nativeId, link.origin])).toEqual([
      ['s-1', 'created'],
      ['s-1', 'resumed'],
      ['s-2', 'created'],
      ['s-2', 'resumed'],
      ['s-3', 'created'],
      ['s-3', 'resumed']
    ])
    const reopened = await openTestAgentSessionRecordStore(directory)
    expect(reopened.getRecord('session-alpha')?.providerHandleChain).toEqual(
      resumed.providerHandleChain
    )
  }, 60_000)
})
