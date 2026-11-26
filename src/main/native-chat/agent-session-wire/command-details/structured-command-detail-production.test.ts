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
import {
  emitSubscriberFrame,
  type SubscriberFieldHooks
} from '../publication/subscribers/agent-session-subscriber-frame-fields'
import { republishSubscriberBackgroundTasks } from '../publication/subscribers/agent-session-live-publications'
import type { Subscriber } from '../publication/subscribers/agent-session-subscribe-input'
import type { SubscriberDeliveryPort } from '../publication/subscribers/agent-session-subscriber-catch-up'
import type { AgentSessionSubscribeEvent } from '../../../../shared/agent-session/agent-session-wire'
import { setStructuredAgentSessionHost } from '../host/structured-agent-session-registry'
import { deleteBotGroup } from '../../../bots/bot-group-membership'
import type { BotGroupRuntime } from '../../../bots/bot-group-runtime'
import { createCommandDetailAuthority } from '../../../../shared/agent-session/view/live-read/command-detail-authority'

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
function host(
  options: {
    membership?: (sessionId: string) => boolean
    /** What the host's subscribers do when the channel asks them to republish. */
    republish?: (sessionId: string, creditedOnly: boolean) => void
  } = {}
) {
  const hooks: SubscriberFieldHooks = {}
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
    {
      hooks,
      republishBackgroundTasks: (id: string, creditedOnly = false) =>
        options.republish?.(id, creditedOnly)
    } as never,
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
  return { ownership, conversations, deliver, channel, tuple, hooks }
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

describe('a quiet, already-credited reader and a real membership writer', () => {
  const MEMBER = 'bot-group-member-fixture-2'

  it('deleting the group withdraws the command from the credited reader: its opening is lost, Copy refused, a fresh host read refused', async () => {
    const orchestration = new OrchestrationDb(':memory:')
    databases.push(orchestration)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: membership reads only the orchestration database
    const runtime = { getOrchestrationDb: () => orchestration } as unknown as OrcaRuntimeService
    const store = runtimeBotGroups(runtime).store
    store.put({
      id: 'group-2',
      name: 'Fixture crew',
      hostId: 'local',
      revision: 1,
      folder: 'group-fixture-2',
      folderWorkspaceId: 'home-2',
      createdAt: 1,
      members: [{ botId: 'bot-0', sessionId: MEMBER }],
      remoteMembers: [],
      replyMode: { kind: 'mentions' }
    })

    // The host's subscriber side, reduced to its republish rule: credited readers only when asked,
    // each through the real lane read and frame emission.
    const sent: AgentSessionSubscribeEvent[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; the lane and frame code read only these fields
    const reader = {
      id: 'reader-1',
      sessionId: MEMBER,
      emit: (event: AgentSessionSubscribeEvent) => sent.push(event),
      cursor: { epoch: 'e', sequence: 3 },
      fence: 1,
      boundedFrames: false
    } as unknown as Subscriber
    const lanes: Promise<void>[] = []
    const h = host({
      membership: (id) => botGroupSessionMembershipCurrent(runtime, id),
      republish: (id, creditedOnly) => {
        if (!creditedOnly || reader.detailCredit) {
          lanes.push(republishSubscriberBackgroundTasks(port, reader, id, 1))
        }
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; republish reads hooks and emit only
    const port = {
      hooks: h.hooks,
      emit: (target: Subscriber, event: AgentSessionSubscribeEvent) =>
        emitSubscriberFrame(h.hooks, target, event)
    } as unknown as SubscriberDeliveryPort
    h.conversations.set(MEMBER, codexRecord(MEMBER))
    h.deliver(MEMBER, [evidence(EXACT)])
    const tuple = h.tuple(MEMBER)!

    // The reader is credited by an ordinary opening frame, and the dialog has fetched the text.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; an opening frame with the fields the lane and viewer read
    const opening = {
      type: 'snapshot',
      sessionId: MEMBER,
      fence: FENCE,
      page: { epoch: 'e', liveCursor: { epoch: 'e', sequence: 3 }, window: { nextCursor: null } },
      backgroundTasks: h.channel.read(MEMBER)
    } as unknown as AgentSessionSubscribeEvent
    await emitSubscriberFrame(h.hooks, reader, opening)
    expect(reader.detailCredit).toBe(true)
    const viewer = createCommandDetailAuthority()
    const scope = { transport: {}, generation: 1 }
    viewer.invalidate(scope)
    viewer.observe(scope, opening, 'runtime-a')
    const dialog = viewer.open(tuple, () => true)!
    const fetched = h.channel.commandDetail(MEMBER, tuple)
    expect(fetched).toBe(EXACT)
    expect(dialog.check()).toBe(true)

    // The real writer; the installed host forwards its revocation to the channel, as in production.
    setStructuredAgentSessionHost(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; the revocation path calls only publishBackgroundTasks
      {
        publishBackgroundTasks: (id: string) => h.channel.publish(id, true)
      } as never
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; deleteBotGroup reads only these fields, and its session closes are settled
    const groups = {
      store,
      queues: new Map(),
      changed: () => {},
      runtime: {
        ensureStructuredAgentSessionHost: async () => {
          throw new Error('no host in this test')
        },
        getOrchestrationDb: () => orchestration,
        bots: { list: () => [] },
        deleteFolderWorkspace: async () => {}
      }
    } as unknown as BotGroupRuntime
    try {
      await deleteBotGroup(groups, 'group-2').catch(() => {})
    } finally {
      setStructuredAgentSessionHost(null)
    }
    await Promise.all(lanes)

    // After the opening frame, exactly one publication to the credited reader: the row is still
    // listed, its command is not.
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ type: 'snapshot', sessionId: MEMBER })
    const withdrawal = sent[1]!
    expect(withdrawal.type).toBe('batch')
    const roster = withdrawal.type === 'batch' ? withdrawal.backgroundTasks : undefined
    expect(roster?.children?.map((child) => child.id)).toContain(tuple.childWorkId)
    expect(roster?.commandDetailsAvailable).toBeUndefined()
    // The viewer applies it: the open dialog's credit is gone, so Copy of the fetched text is refused.
    viewer.observe(scope, withdrawal, 'runtime-a')
    expect(dialog.lost).toBe(true)
    expect(dialog.check()).toBe(false)
    expect(viewer.open(tuple, () => true)).toBeNull()
    // And a fresh read on the host is refused.
    expect(h.channel.commandDetail(MEMBER, tuple)).toBeNull()
  })
})
