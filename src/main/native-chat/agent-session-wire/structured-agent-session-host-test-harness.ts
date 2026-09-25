import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds,
  hostTestLaunchDirectory
} from './structured-agent-session-host-test-data'

const journals = createTrackedJournalOpener()

const CALLER = { callerKey: 'client-1' }

function envelope(
  method: string,
  fields: Record<string, unknown>,
  overrides: Partial<AgentSessionMutationEnvelope> = {}
): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    }),
    ...overrides
  }
}

const attachParams = (
  overrides: Partial<AgentSessionAttachParams> = {}
): AgentSessionAttachParams => hostTestAttachParams(null, overrides)

const ensureParams = (fence: number): AgentSessionAttachParams => hostTestAttachParams(fence)

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let releaseAcquisition: Mock<NonNullable<StructuredAgentSessionAdapter['releaseAcquisition']>>
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>
let answerPrompt: Mock<StructuredAgentSessionAdapter['answerPrompt']>
let setOption: Mock<StructuredAgentSessionAdapter['setOption']>
let ordinal = 0

function accepted(): AgentSessionDispatchOutcome {
  ordinal += 1
  return {
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal }
  }
}

function adapter(): StructuredAgentSessionAdapter {
  return {
    acquire,
    releaseAcquisition,
    dispatch: async (input) => {
      await input.beforeDispatch?.()
      return dispatch(input)
    },
    cancelTurn,
    answerPrompt,
    setOption
  }
}

async function attach(): Promise<AgentSessionRecord | null> {
  const result = await host.attach(CALLER, attachParams())
  expect(result.ok).toBe(true)
  return store.getRecord(SESSION)
}

/** Emits a pending approval through the acquired provider sink. */
async function seedApproval(optionId = 'allow'): Promise<{ itemId: string; revision: number }> {
  const identity = { provider: 'codex' as const, threadId: THREAD, turnId: 'turn-1', ordinal: 99 }
  const events = acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('seedApproval requires an acquired session')
  }
  events.appendItem(identity, {
    kind: 'approval',
    title: 'Run the command?',
    detail: null,
    options: [{ id: optionId, label: 'Allow' }],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  })
  await host.flushStreamedEvents(SESSION)
  const itemId = agentJournalItemKey(identity)
  const page = host.history({ sessionId: SESSION, direction: 'tail' })
  const appended = page.ok ? page.page.items.find((item) => item.itemId === itemId) : null
  if (!appended) {
    throw new Error('provider approval was not written to the journal')
  }
  return { itemId, revision: appended.revision }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-host-'))
  resetHostTestOperationIds()
  ordinal = 0
  acquire = vi.fn(async ({ fence }) => ({
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
    },
    link: {
      linkId: `link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }))
  releaseAcquisition = vi.fn(async () => true)
  dispatch = vi.fn(async () => accepted())
  cancelTurn = vi.fn(async () => ({ cancelled: true }))
  answerPrompt = vi.fn(async ({ commit }) => commit())
  setOption = vi.fn(async () => undefined)
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    recoveryCapsule: new AgentSessionRecoveryCapsule(root),
    claimKeyId: 'key-1',
    resolveLaunchDirectory: hostTestLaunchDirectory,
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
})

afterEach(async () => {
  await journals.closeAll()
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

/** A restarted process swaps the store and the host under the same directories.
 *  The helpers here close over both, so they have to be told. */
export function replaceHostTestState(next: {
  store: AgentSessionRecordStore
  host: StructuredAgentSessionHost
}): void {
  store = next.store
  host = next.host
}

/** The live per-test state. Read it in a `beforeEach` so a suite's test bodies
 *  keep using bare `host` / `store` / `dispatch` exactly as they did when this
 *  setup was inline. */
export function hostTestState() {
  return {
    root,
    store,
    host,
    acquire,
    releaseAcquisition,
    dispatch,
    cancelTurn,
    answerPrompt,
    setOption
  }
}

export {
  CALLER,
  accepted,
  adapter,
  attach,
  attachParams,
  ensureParams,
  envelope,
  journals,
  seedApproval
}
