// A real background-task channel over a real authority status store and its exact-command slots:
// the Codex tracker's occurrences are admitted the way the producer admits them.

import { vi } from 'vitest'
import { createAgentStatusStore } from '../../../../shared/agent-status/store/agent-status-store'
import { createAgentChildWorkAdmission } from '../../../../shared/agent-status/child-work/agent-status-child-work-admission'
import { reconcileAgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-reconciliation'
import { makeStructuredAgentStatusSubject } from '../../../../shared/agent-status/contracts/agent-status-subject'
import { projectAgentChildWorkViews } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentChildWorkEvidence } from '../../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { StructuredCommandDetailSlots } from './structured-command-detail-slots'
import {
  createStructuredCommandOccurrence,
  markLiveEvidenceOccurrence
} from './structured-command-occurrence'
import { StructuredAgentSessionBackgroundTaskChannel } from '../publication/subscribers/structured-agent-session-background-task-channel'

export const CHANNEL_SESSION = '11111111-1111-4111-8111-111111111111'

const parent = makeStructuredAgentStatusSubject(
  { executionHostId: 'local', wslDistro: null, workspaceId: '/w', workspaceKind: 'folder' },
  CHANNEL_SESSION
)

type Owner = Record<string, unknown>

export const LIVE_OWNER: Owner = {
  claimStatus: 'live',
  unreconciled: false,
  ownerProcess: { pid: 1, spawnToken: 'spawn-1' },
  reservedSpawnToken: 'spawn-1',
  handoffStage: null,
  handoffOperationId: null,
  deathEvidence: null
}

/** `rows` background commands admitted at `fence` from a current producer. */
export function commandDetailChannel(options: { rows?: number; fence?: number } = {}) {
  const rows = options.rows ?? 1
  const fence = options.fence ?? 5
  const slots = new StructuredCommandDetailSlots()
  const store = createAgentStatusStore({
    epoch: 'command-detail-channel',
    mode: 'authority',
    onChildrenCommitted: slots.committed
  })
  store.applyMutation({ parent: { subject: parent } })
  let minted = 0
  const admission = createAgentChildWorkAdmission(store, {
    mintChildWorkId: () => `child-${++minted}`
  })
  const evidence: AgentChildWorkEvidence[] = []
  const exact = new Map<string, string>()
  for (let index = 1; index <= rows; index++) {
    const child = {
      handle: { idKind: 'task_id' as const, id: `codex-command:primary:call-${index}` },
      kind: 'command' as const,
      residency: 'background' as const,
      state: 'working' as const,
      description: `fixture-step ${index}`,
      stoppable: true
    }
    const text = `fixture-step ${index} --flag "x y"\n  && fixture-done`
    markLiveEvidenceOccurrence(child, new WeakRef(createStructuredCommandOccurrence(text)))
    evidence.push({ type: 'live', observedAt: 10, child })
  }
  reconcileAgentChildWorkEvidence({
    store,
    admission,
    parent,
    provider: 'codex',
    evidence,
    liveAdmission: slots.observer((id) => store.getChild(id), { fence })
  })
  for (const record of store.getChildren(parent)) {
    exact.set(record.childWorkId, slots.read(store.getChild(record.childWorkId)!)!.display)
  }
  const state = {
    conversation: { provider: 'codex', currentFence: fence, ownerObservation: { ...LIVE_OWNER } },
    member: true,
    /** Whether the conversation is open (the present lane) or released (the absent lane). */
    open: true
  }
  const membership = vi.fn((_sessionId: string) => state.member)
  const getConversation = vi.fn((sessionId: string) =>
    sessionId === CHANNEL_SESSION ? state.conversation : null
  )
  const hooks: Record<string, unknown> = {}
  const channel = new StructuredAgentSessionBackgroundTaskChannel(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the deps the channel reads
    {
      store: { getConversation },
      sessionMembershipCurrent: membership,
      adapter: {}
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
    {
      get: (sessionId: string) =>
        state.open && sessionId === CHANNEL_SESSION ? { params: { provider: 'codex' } } : undefined
    } as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
    { hooks, republishBackgroundTasks: () => {} } as never,
    async () => {
      throw new Error('unused')
    },
    async () => null,
    {
      readChildWork: () => projectAgentChildWorkViews(store.getChildren(parent), []),
      readCommandDetail: (_sessionId, childWorkId) => {
        const record = store.getChild(childWorkId)
        return record ? { record, slot: slots.read(record) } : null
      }
    }
  )
  const tuples = () =>
    store.getChildren(parent).map((record) => ({
      childWorkId: record.childWorkId,
      invocationId: record.invocation.invocationId,
      generation: record.invocation.generation
    }))
  return { channel, state, membership, getConversation, exact, tuples, fence }
}
