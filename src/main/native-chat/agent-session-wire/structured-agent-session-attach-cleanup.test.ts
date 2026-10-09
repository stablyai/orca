import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { MAX_JOURNAL_LIFECYCLE_BATCH_BYTES } from '../agent-session-journal/journal-row-schema'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'
import {
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  pendingPromptExists,
  structuredQueueHold
} from './structured-agent-session-queued-messages'
import {
  createRestTestRig,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD as THREAD,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

let rig: RestTestRig
const retired: StructuredAgentSessionHost[] = []

beforeEach(async () => {
  // Recorded, not printed: the retired host's handle on the shared journal logs its own exit.
  rig = await createRestTestRig({
    logger: recordingStructuredAgentSessionLogger().logger,
    idleSweep: { intervalMs: 3_600_000 }
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(retired.splice(0).map((host) => host.flushAllStreamedEvents()))
  await rig.dispose()
})

type LeftoverItem = { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

async function crashRestart(): Promise<void> {
  retired.push(rig.host)
  rig.store = await openTestAgentSessionRecordStore(rig.root)
  rig.host = new StructuredAgentSessionHost({ ...rig.host.deps, store: rig.store })
  await rig.host.reconcileRestartLeases()
}

/** A chat whose agent died mid-turn, leaving the turn running and `extra` open inside it. */
async function restartWithRunningTurn(extra: readonly LeftoverItem[] = []): Promise<void> {
  expect(await rig.host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  const conversation = rig.host.collaboratorsForTests().sessions.get(SESSION)!
  const fence = conversation.child!.fence
  const turn = await conversation.journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'old', ordinal: 1 },
    { kind: 'turn', turnId: 'old', state: 'running' },
    { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  for (const item of extra) {
    await conversation.journal.appendItem(item.identity, item.body, {
      fence,
      turnScope: { kind: 'turn', turnItemId: turn.itemId }
    })
  }
  await crashRestart()
}

/** A tool call larger than any cleanup row (a defensive case: no provider writes one in normal
 *  use), and a request the dead agent was waiting on. */
function leftoverWork(): LeftoverItem[] {
  return [
    {
      identity: { provider: 'orca', clientMessageId: 'claude-tool:s:toolu-big' },
      body: {
        kind: 'tool-call',
        name: 'Write',
        input: {
          file_path: '/repo/big.txt',
          content: 'x'.repeat(MAX_JOURNAL_LIFECYCLE_BATCH_BYTES)
        },
        callId: 'toolu-big',
        state: 'running'
      }
    },
    {
      identity: { provider: 'orca', clientMessageId: 'prompt-old' },
      body: {
        kind: 'approval',
        title: 'Allow the tool?',
        detail: null,
        options: [{ id: 'yes', label: 'Allow' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    }
  ]
}

function journal(): AgentSessionJournal {
  return rig.host.collaboratorsForTests().sessions.get(SESSION)!.journal
}

async function turnStates(): Promise<Record<string, string>> {
  const snapshot = await rig.host.journalSnapshot(SESSION)
  return Object.fromEntries(
    snapshot.items.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn ? [[turn.turnId, turn.state]] : []
    })
  )
}

/** A person's send from a chat that queues while the agent works. */
function queueableSend(text: string) {
  const body = hostTestMessage(text)
  const delivery = 'queue-if-active' as const
  return {
    body,
    delivery,
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body, delivery }
      })
    }
  }
}

function expectLeftoverWorkSettled(): void {
  const settled = journal()
  expect(settled.activeTurnId()).toBeNull()
  expect(pendingPromptExists(settled)).toBe(false)
  const bodies = settled.snapshot().items.map((item) => item.body)
  expect(bodies.find((body) => body.kind === 'tool-call')).toMatchObject({
    state: 'failed',
    endedAs: 'interrupted'
  })
  expect(bodies.find((body) => body.kind === 'approval')).toMatchObject({
    resolution: { state: 'cancelled' }
  })
}

it('resumes a chat whose dead agent left an item larger than any cleanup row, then sends', async () => {
  await restartWithRunningTurn(leftoverWork())

  const attached = await rig.host.attach(
    CALLER,
    hostTestAttachParams(rig.store.getRecord(SESSION)!.lease.runtimeFence)
  )

  expect(attached, JSON.stringify(attached).slice(0, 500)).toMatchObject({ ok: true })
  expect(await turnStates()).toEqual({ old: 'interrupted' })
  expectLeftoverWorkSettled()
  const record = rig.store.getRecord(SESSION)
  expect(
    structuredQueueHold({ journal: journal(), record, fence: record!.lease.runtimeFence })
  ).toBe(null)

  const sent = await rig.host.send(CALLER, queueableSend('next step'))

  expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true })
  expect(sent.ok && 'queued' in sent.value).toBe(false)
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1))
})

it('settles the same leftovers when the chat is reopened, so a send is not queued behind them', async () => {
  await restartWithRunningTurn(leftoverWork())

  expect(await turnStates()).toEqual({ old: 'interrupted' })
  expectLeftoverWorkSettled()

  const sent = await rig.host.send(CALLER, queueableSend('after reopening'))

  expect(sent, JSON.stringify(sent)).toMatchObject({ ok: true })
  expect(sent.ok && 'queued' in sent.value).toBe(false)
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(1))
})

it('fails the start and releases the new agent when the old turn cleanup cannot be written', async () => {
  await restartWithRunningTurn()
  const error = Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' })
  vi.spyOn(AgentSessionJournal.prototype, 'appendLifecycleBatch').mockRejectedValueOnce(error)
  const release = vi.mocked(rig.host.deps.adapter.releaseAcquisition!)

  const attached = await rig.host
    .attach(CALLER, hostTestAttachParams(rig.store.getRecord(SESSION)!.lease.runtimeFence))
    .catch((thrown: unknown) => thrown)

  expect(attached).not.toMatchObject({ ok: true })
  expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
  expect(release).toHaveBeenCalledTimes(1)
  expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child ?? null).toBeNull()
  expect(rig.adapter.dispatch).not.toHaveBeenCalled()
})
