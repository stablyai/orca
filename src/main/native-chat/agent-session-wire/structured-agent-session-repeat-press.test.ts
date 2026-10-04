// What the host does with a second press of the same control, against the real host, store and
// journal: under the first press's id it answers from that press and does nothing more, which is
// why a client sends every press under a new id; under a new id it acts.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionRefusalOperationState } from '../../../shared/agent-session-refusal-retry'
import type { AgentSessionThreadGoalChange } from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let setOption: Mock<StructuredAgentSessionAdapter['setOption']>
let changeThreadGoal: Mock<NonNullable<StructuredAgentSessionAdapter['changeThreadGoal']>>
let stopBackgroundTasks: Mock<NonNullable<StructuredAgentSessionAdapter['stopBackgroundTasks']>>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-repeat-press-'))
  resetHostTestOperationIds()
  setOption = vi.fn(async () => undefined)
  changeThreadGoal = vi.fn(async () => ({ ok: true as const }))
  stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
  cancelTurn = vi.fn(async () => ({ cancelled: true }))
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      acquire: async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
        acquisitionGeneration: 'generation-1',
        link: {
          linkId: `link-${fence}`,
          handle: { provider: 'codex' as const, threadId: THREAD },
          origin: fence > 1 ? ('resumed' as const) : ('created' as const),
          mintedAtFence: fence,
          observedAt: NOW
        }
      }),
      dispatch: vi.fn(async () => ({ state: 'admitted' as const })),
      closeSession: vi.fn(async () => true),
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn,
      answerPrompt: vi.fn(async () => undefined),
      setOption,
      changeThreadGoal,
      supportsThreadGoal: () => true,
      stopBackgroundTasks
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-1',
    now: () => NOW
  })
  expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

function envelope(
  method: string,
  fields: Record<string, unknown>,
  clientOperationId: string,
  expectedRuntimeFence: number | null = 1
) {
  return {
    sessionId: SESSION,
    clientOperationId,
    expectedRuntimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function pick(value: string, id = hostTestOperationId(), fence: number | null = 1) {
  const fields = { key: 'model', value }
  return host.setOption(CALLER, {
    envelope: envelope('agentSession.setOption', fields, id, fence),
    ...fields
  })
}

describe('a press sent again', () => {
  it('leaves an option on the other pick under the first id, and applies it under a new one', async () => {
    const first = hostTestOperationId()
    await pick('A', first)
    await pick('B')

    expect(await pick('A', first)).toMatchObject({ ok: true, replayed: true })
    expect(setOption.mock.calls.map(([input]) => input.value)).toEqual(['A', 'B'])

    expect(await pick('A')).toMatchObject({ ok: true, replayed: false })
    expect(setOption.mock.calls.map(([input]) => input.value)).toEqual(['A', 'B', 'A'])
  })

  it('leaves a cleared goal cleared under the first id, and sets it under a new one', async () => {
    const change = (next: AgentSessionThreadGoalChange, id = hostTestOperationId()) =>
      host.changeThreadGoal(CALLER, {
        envelope: envelope('agentSession.threadGoal', { change: next }, id),
        change: next
      })
    const set: AgentSessionThreadGoalChange = { kind: 'set', objective: 'Ship the parser' }
    const first = hostTestOperationId()
    await change(set, first)
    await change({ kind: 'clear' })

    expect(await change(set, first)).toMatchObject({ ok: true, replayed: true })
    expect(changeThreadGoal).toHaveBeenCalledTimes(2)

    expect(await change(set)).toMatchObject({ ok: true, replayed: false })
    expect(changeThreadGoal).toHaveBeenCalledTimes(3)
  })

  it('stops a background task only under a new id once the first Stop ran', async () => {
    const fields = { turnId: 'background-tasks', scope: 'background-tasks', taskId: 'task-1' }
    const stop = (id = hostTestOperationId()) =>
      host.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', fields, id),
        turnId: 'background-tasks',
        scope: 'background-tasks' as const,
        taskId: 'task-1'
      })
    // The first Stop reached the task before it could be stopped; its answer never arrived.
    stopBackgroundTasks.mockResolvedValueOnce({ cancelled: false })
    const first = hostTestOperationId()
    await stop(first)

    expect(await stop(first)).toMatchObject({
      ok: true,
      replayed: true,
      value: { cancelled: false }
    })
    expect(stopBackgroundTasks).toHaveBeenCalledOnce()

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(stopBackgroundTasks).toHaveBeenCalledTimes(2)
  })

  it('interrupts a named turn only under a new id once the first Stop ran', async () => {
    const stop = (id = hostTestOperationId()) =>
      host.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', { turnId: 'turn-1' }, id, null),
        turnId: 'turn-1'
      })
    cancelTurn.mockResolvedValueOnce({ cancelled: false })
    const first = hostTestOperationId()
    await stop(first)

    expect(await stop(first)).toMatchObject({
      ok: true,
      replayed: true,
      value: { cancelled: false }
    })
    expect(cancelTurn).toHaveBeenCalledOnce()

    expect(await stop()).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(cancelTurn).toHaveBeenCalledTimes(2)
  })

  it('keeps nothing of a press it turned away before running, so its own id runs next time', async () => {
    const fields = { turnId: 'background-tasks', scope: 'background-tasks' }
    const id = hostTestOperationId()
    const stop = (fence: number) =>
      host.cancel(CALLER, {
        envelope: envelope('agentSession.cancel', fields, id, fence),
        turnId: 'background-tasks',
        scope: 'background-tasks' as const
      })
    await host.close(SESSION, 'evict')

    // No agent owns the chat, so the host turns the Stop away as not ready.
    expect(await stop(1)).toMatchObject({ ok: false })
    const refused = await stop(1)
    expect(refused.ok ? null : agentSessionRefusalOperationState(refused.refusal.code)).toBe(
      'pending-admission'
    )
    const fence = store.getRecord(SESSION)!.lease.runtimeFence
    expect(await host.attach(CALLER, hostTestAttachParams(fence))).toMatchObject({ ok: true })

    expect(await stop(store.getRecord(SESSION)!.lease.runtimeFence)).toMatchObject({
      ok: true,
      replayed: false,
      value: { cancelled: true }
    })
    expect(stopBackgroundTasks).toHaveBeenCalledOnce()
  })
})
