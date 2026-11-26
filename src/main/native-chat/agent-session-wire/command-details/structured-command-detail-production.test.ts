import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

import { AgentHookServer } from '../../../agent-hooks/server/agent-hook-server'
import { StructuredAgentSessionStatusOwnership } from '../observations/structured-agent-session-status-ownership'
import { StructuredAgentSessionBackgroundTaskChannel } from '../publication/subscribers/structured-agent-session-background-task-channel'
import {
  createStructuredCommandOccurrence,
  markLiveEvidenceOccurrence
} from './structured-command-occurrence'
import type { AgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { agentSessionOperationKey } from '../../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import { settleFailedAgentSessionPostAcquisitionAttachment } from '../../../runtime/agent-session/ownership/agent-session-acquisition-failure-settlement'
import type { AgentSessionStoreState } from '../../../runtime/agent-session/records/agent-session-store-state'
import { botGroupSessionMembershipCurrent } from '../../../bots/bot-group-session-access'
import { runtimeBotGroups } from '../../../bots/bot-group-runtime'
import { OrchestrationDb } from '../../../runtime/orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { BotGroup } from '../../../../shared/bots/bot-group'

// Production boundaries for the exact command: the hook server's canonical store and slots,
// status ownership's landed parent and producer-fence stamping, a record settled by the real
// failed-acquisition settlement, and the real group membership store. Only the provider is absent.

const FENCE = 7
const LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}
const S_A = '11111111-1111-4111-8111-111111111111'
const S_B = '22222222-2222-4222-8222-222222222222'
const S_C = '33333333-3333-4333-8333-333333333333'
const EXACT = 'fixture-step --flag "x y"\n  && fixture-done'

function evidence(text: string, id = 'codex-command:primary:call-1'): AgentChildWorkEvidence {
  const child = {
    handle: { idKind: 'task_id' as const, id },
    kind: 'command' as const,
    residency: 'background' as const,
    state: 'working' as const,
    description: 'fixture-step',
    stoppable: true
  }
  markLiveEvidenceOccurrence(child, new WeakRef(createStructuredCommandOccurrence(text)))
  return { type: 'live', observedAt: 10, child }
}

function codexRecord(sessionId: string) {
  return {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId, runtimeFence: FENCE })),
    provider: 'codex'
  }
}

const databases: OrchestrationDb[] = []
let server: AgentHookServer

beforeEach(() => {
  server = new AgentHookServer()
})
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

/** A producer whose only job here is the fence-bound callback; it appends nothing. */
function producerAt(fence: number) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; ownership calls only publishChildWork, and the bound callback reads only the fence
  return {
    publishChildWork: (_items: unknown, bound: (journal: null, fence: number) => void) => {
      bound(null, fence)
      return { accepted: true }
    }
  } as never
}

/** One host: ownership over the real server sink, conversations by id, and a channel over both. */
function host(options: { membership?: (sessionId: string) => boolean } = {}) {
  const conversations = new Map<string, ReturnType<typeof codexRecord>>()
  const ownership = new StructuredAgentSessionStatusOwnership(() => ({
    statusSink: () => ({
      publish: (summary, subject) => server.ingestStructuredStatus(summary, subject),
      forget: (subject) => server.dropStructuredStatus(subject),
      publishChildWork: (subject, items, provider, authority) =>
        server.ingestStructuredChildWork(subject, items, provider, authority),
      readChildWork: (subject) => server.getStructuredChildWorkViews(subject),
      readCommandDetail: (subject, childWorkId) =>
        server.getStructuredCommandDetail(subject, childWorkId)
    }),
    onSubjectForgotten: () => {}
  }))
  // One stable session object per id: ownership checks the session it started with is still current.
  const sessions = new Map<
    string,
    { params: { location: AgentSessionExecutionLocation; provider: string } }
  >()
  const session = (sessionId: string) => {
    if (!conversations.has(sessionId)) {
      return undefined
    }
    let found = sessions.get(sessionId)
    if (!found) {
      found = { params: { location: LOCATION, provider: 'codex' } }
      sessions.set(sessionId, found)
    }
    return found
  }
  /** Lands the parent, then delivers through the producer callback with its bound fence. */
  const deliver = (sessionId: string, items: AgentChildWorkEvidence[], boundFence = FENCE) =>
    ownership.publishChildWorkAfterWrites(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the deps this path reads
      {
        sessions: { get: session },
        getConversation: (id: string) => {
          const record = conversations.get(id)
          return record ? agentSessionConversationView(record) : null
        },
        now: () => 1,
        logger: { warn: () => {} }
      } as never,
      sessionId,
      items,
      producerAt(boundFence),
      () => ownership.deliverChildWork(sessionId, items, 'codex')
    )
  const channel = new StructuredAgentSessionBackgroundTaskChannel(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the deps the channel reads
    {
      store: {
        getConversation: (id: string) => {
          const record = conversations.get(id)
          return record ? agentSessionConversationView(record) : null
        }
      },
      ...(options.membership ? { sessionMembershipCurrent: options.membership } : {}),
      adapter: {}
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
    { get: session } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
    { hooks: {}, republishBackgroundTasks: () => {} } as never,
    async () => {
      throw new Error('unused')
    },
    async () => null,
    {
      readChildWork: (id) => ownership.readChildWork(id),
      readCommandDetail: (id, childWorkId) => ownership.readCommandDetail(id, childWorkId)
    }
  )
  const tuple = (sessionId: string) => {
    const [view] = ownership.readChildWork(sessionId) ?? []
    return view?.invocation
      ? {
          childWorkId: view.id,
          invocationId: view.invocation.invocationId,
          generation: view.invocation.generation
        }
      : null
  }
  return { ownership, conversations, deliver, channel, tuple }
}

describe('exact command through the production landed parent', () => {
  it('a landed parent with a current producer fence reads the bytes; nothing else does', () => {
    const h = host()
    h.conversations.set(S_A, codexRecord(S_A))
    h.deliver(S_A, [evidence(EXACT)])
    const tuple = h.tuple(S_A)!
    expect(h.channel.commandDetail(S_A, tuple)).toBe(EXACT)
    const [read] = [h.channel.read(S_A)]
    expect(read?.commandDetailsAvailable).toEqual([tuple])
  })

  it('another landed session asking for this child (wrong parent) gets nothing', () => {
    const h = host()
    h.conversations.set(S_A, codexRecord(S_A))
    h.conversations.set(S_B, codexRecord(S_B))
    h.deliver(S_A, [evidence(EXACT)])
    h.deliver(S_B, [evidence('other', 'codex-command:primary:call-9')])
    const tuple = h.tuple(S_A)!
    expect(h.ownership.readCommandDetail(S_B, tuple.childWorkId)).toBeNull()
    expect(h.channel.commandDetail(S_B, tuple)).toBeNull()
    // Control: its own parent still reads.
    expect(h.channel.commandDetail(S_A, tuple)).toBe(EXACT)
  })

  it('an unlanded parent reads nothing, and a producer at another fence binds nothing', () => {
    const h = host()
    h.conversations.set(S_A, codexRecord(S_A))
    // No parent landed for s-c: a read through ownership finds nothing.
    expect(h.ownership.readCommandDetail(S_C, 'any')).toBeNull()
    h.deliver(S_A, [evidence(EXACT)], FENCE - 1)
    const tuple = h.tuple(S_A)!
    expect(h.ownership.readCommandDetail(S_A, tuple.childWorkId)?.slot).toBeUndefined()
    expect(h.channel.commandDetail(S_A, tuple)).toBeNull()
  })
})

describe('exact command and a genuine pending settlement', () => {
  it('an unproven failed attachment settles the live owner into recovery at the same fence and withdraws the bytes', () => {
    const h = host()
    const record = codexRecord(S_A)
    h.conversations.set(S_A, record)
    h.deliver(S_A, [evidence(EXACT)])
    const tuple = h.tuple(S_A)!
    expect(h.channel.commandDetail(S_A, tuple)).toBe(EXACT)
    const state: AgentSessionStoreState = {
      records: new Map([[S_A, record]]),
      operations: new Map([
        [
          agentSessionOperationKey('caller-1', 'op-1'),
          {
            callerKey: 'caller-1',
            operationId: 'op-1',
            fingerprint: 'f',
            operationTimestamp: 1,
            recordedAt: 1,
            expiresAt: 1e12,
            outcome: { status: 'pending' }
          }
        ]
      ]),
      retiredClaimKeys: [],
      unreadableRecords: new Map(),
      sessionTabs: null
    }
    const settled = settleFailedAgentSessionPostAcquisitionAttachment(state, {
      sessionId: S_A,
      fence: FENCE,
      spawnToken: record.lease.reservedSpawnToken!,
      callerKey: 'caller-1',
      operationId: 'op-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settlement stores the failed outcome opaquely; its fields are not read here
      outcome: { status: 'failed', code: 'fixture_failure', message: 'fixture' } as never,
      exitProof: 'unproven',
      now: 2
    })
    // The real write: same fence, the same process, parked in recovery.
    expect(settled.lease.runtimeFence).toBe(FENCE)
    expect(settled.lease.handoffStage).toBe('recovering')
    h.conversations.set(S_A, { ...settled, provider: 'codex' })
    expect(h.channel.commandDetail(S_A, tuple)).toBeNull()
    expect(h.channel.read(S_A)?.commandDetailsAvailable).toBeUndefined()
  })
})

describe('exact command and the real group membership store', () => {
  const MEMBER = 'bot-group-member-fixture-1'

  function groups() {
    const orchestration = new OrchestrationDb(':memory:')
    databases.push(orchestration)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: membership reads only the orchestration database
    const runtime = { getOrchestrationDb: () => orchestration } as unknown as OrcaRuntimeService
    const group = (members: BotGroup['members']): BotGroup => ({
      id: 'group-1',
      name: 'Fixture crew',
      hostId: 'local',
      revision: 1,
      folder: 'group-fixture',
      folderWorkspaceId: 'home-1',
      createdAt: 1,
      members,
      remoteMembers: [],
      replyMode: { kind: 'mentions' }
    })
    return { runtime, store: runtimeBotGroups(runtime).store, group }
  }

  it('a current member reads; once retired from the group, the same tuple reads nothing', () => {
    const g = groups()
    g.store.put(g.group([{ botId: 'bot-0', sessionId: MEMBER }]))
    const h = host({ membership: (id) => botGroupSessionMembershipCurrent(g.runtime, id) })
    h.conversations.set(MEMBER, codexRecord(MEMBER))
    h.deliver(MEMBER, [evidence(EXACT)])
    const tuple = h.tuple(MEMBER)!
    expect(h.channel.commandDetail(MEMBER, tuple)).toBe(EXACT)
    g.store.put(g.group([]))
    expect(h.channel.commandDetail(MEMBER, tuple)).toBeNull()
    expect(h.channel.read(MEMBER)?.commandDetailsAvailable).toBeUndefined()
  })

  it('a non-group session never consults the group store', () => {
    const g = groups()
    const list = vi.spyOn(g.store, 'list')
    const h = host({ membership: (id) => botGroupSessionMembershipCurrent(g.runtime, id) })
    h.conversations.set(S_A, codexRecord(S_A))
    h.deliver(S_A, [evidence(EXACT)])
    expect(h.channel.commandDetail(S_A, h.tuple(S_A)!)).toBe(EXACT)
    expect(list).not.toHaveBeenCalled()
  })
})
