import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { DISPATCH_REJECTED_CANCELLED } from '../../../shared/structured-agent-session-dispatch-rejection'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionSubscribeEvent
} from '../../../shared/agent-session-wire'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { startsWhenPublished } from './structured-agent-session-instant-start.test-support'

import {
  closeStructuredAgentSessionHandovers,
  finalizingStructuredAgentSessionInput,
  structuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'

const CALLER = { callerKey: 'client-1' }

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>

function accepted(): AgentSessionDispatchOutcome {
  return {
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
  }
}

function sendParams(text: string): {
  envelope: AgentSessionMutationEnvelope
  body: ReturnType<typeof hostTestMessage>
} {
  const body = hostTestMessage(text)
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  }
}

async function submissions(): Promise<unknown> {
  const state = await host.history({ sessionId: SESSION, direction: 'tail' })
  return state.ok ? state.page.submissions : null
}

function journal(): AgentSessionJournal {
  return (
    host as unknown as { sessions: Map<string, { journal: AgentSessionJournal }> }
  ).sessions.get(SESSION)!.journal
}

async function handedOver(clientMessageId: string): Promise<void> {
  await vi.waitFor(async () => {
    expect(
      journal()
        .submissions()
        .find((entry) => entry.clientMessageId === clientMessageId)?.handedOverAt
    ).toBeDefined()
    expect(dispatch).toHaveBeenCalled()
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-late-settle-'))
  resetHostTestOperationIds()
  dispatch = vi.fn(async () => accepted())
  closeSession = vi.fn(async () => true)
  store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: startsWhenPublished(
      {
        open: async () => ({
          reportedOptions: { model: '' }
        }),
        acquire: vi.fn(async ({ fence }) => ({
          acquisitionGeneration: globalThis.crypto.randomUUID(),
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: 1_700_000_000_000,
            spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
          },
          link: {
            linkId: `link-${fence}`,
            handle: codexProviderHandle(THREAD),
            origin: 'created' as const,
            mintedAtFence: fence,
            observedAt: NOW
          }
        })),
        releaseAcquisition: vi.fn(async () => true),
        dispatch,
        closeSession,
        cancelTurn: vi.fn(async () => ({ cancelled: true })),
        answerPrompt: vi.fn(async () => undefined),
        setOption: vi.fn(async () => undefined)
      },
      () => host
    ),
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW
  })
  expect((await host.attach(CALLER, hostTestAttachParams(null))).ok).toBe(true)
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await host.close(SESSION, 'evict')
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('settling a send the provider proves it received after the ack window', () => {
  it('publishes acceptance during a pending send and never reopens it for retry', async () => {
    let finishDispatch!: (outcome: AgentSessionDispatchOutcome) => void
    dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDispatch = resolve
        })
    )
    const events: AgentSessionSubscribeEvent[] = []
    const unsubscribe = await host.subscribe({
      id: 'late-receipt',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    const params = sendParams('echo before send completes')
    const pending = host.send(CALLER, params)
    await vi.waitFor(async () => expect(dispatch).toHaveBeenCalledTimes(1))
    try {
      await host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: params.envelope.clientOperationId,
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'early-echo' }
      })
      const accepted = events.findLast(
        (event) =>
          event.type === 'batch' &&
          event.batch.submissions.some(
            (entry) => entry.clientMessageId === params.envelope.clientOperationId
          )
      )
      expect(accepted).toMatchObject({
        type: 'batch',
        batch: {
          submissions: [
            { clientMessageId: params.envelope.clientOperationId, dispatchState: 'accepted' }
          ]
        }
      })
    } finally {
      finishDispatch({ state: 'unknown', reason: 'ack timeout' })
      unsubscribe()
    }
    await expect(pending).resolves.toMatchObject({ ok: true })
    // Late uncertainty must not undo proven acceptance.
    await vi.waitFor(async () =>
      expect(await submissions()).toMatchObject([
        { clientMessageId: params.envelope.clientOperationId, dispatchState: 'accepted' }
      ])
    )
    await expect(host.send(CALLER, { ...params, retryUnknown: true })).resolves.toMatchObject({
      ok: true,
      value: { submission: { dispatchState: 'accepted' } }
    })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it.each(['N-first', 'O-first'] as const)(
    'retains the original result owner with %s',
    async (order) => {
      const original = Promise.withResolvers<AgentSessionDispatchOutcome>()
      const nested = Promise.withResolvers<void>()
      const entered = Promise.withResolvers<void>()
      dispatch.mockImplementationOnce(() => original.promise)
      const held = journal()
      const acceptLate = held.acceptLate.bind(held)
      const acceptance = vi.spyOn(held, 'acceptLate').mockImplementation(async (input) => {
        entered.resolve()
        await nested.promise
        return acceptLate(input)
      })
      const params = sendParams('overlapping result and receipt')
      const id = params.envelope.clientOperationId
      const sending = host.send(CALLER, params)
      let settlement: Promise<void> | undefined
      let observed: Promise<void> | undefined
      let completed = 0
      try {
        await handedOver(id)
        settlement = host.settleLateDispatch({
          sessionId: SESSION,
          clientMessageId: id,
          providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'overlap-echo' }
        })
        void settlement.catch(() => undefined)
        await entered.promise
        const completion = closeStructuredAgentSessionHandovers(held)
        expect(completion).toBeDefined()
        observed = completion?.then(() => {
          completed += 1
        })
        expect(finalizingStructuredAgentSessionInput(held, id)).toBe(true)
        expect(structuredAgentSessionHandingOver(held).has(id)).toBe(true)

        if (order === 'N-first') {
          nested.resolve()
          await settlement
          expect(finalizingStructuredAgentSessionInput(held, id)).toBe(true)
          expect(structuredAgentSessionHandingOver(held).has(id)).toBe(true)
          await new Promise<void>((resolve) => setImmediate(resolve))
          expect(completed).toBe(0)
          original.resolve({ state: 'unknown', reason: 'ack timeout' })
          await observed
        } else {
          original.resolve({ state: 'admitted' })
          await observed
          expect(finalizingStructuredAgentSessionInput(held, id)).toBe(false)
          expect(completed).toBe(1)
          expect(structuredAgentSessionHandingOver(held).has(id)).toBe(true)
          expect(closeStructuredAgentSessionHandovers(held)).toBeUndefined()
          nested.resolve()
          await settlement
        }

        await expect(sending).resolves.toMatchObject({ ok: true })
        await observed
        expect(completed).toBe(1)
        expect(finalizingStructuredAgentSessionInput(held, id)).toBe(false)
        expect(structuredAgentSessionHandingOver(held).has(id)).toBe(false)
        expect(held.submission(id)).toMatchObject({
          clientMessageId: id,
          dispatchState: 'accepted',
          providerItemId: `claude:${THREAD}:overlap-echo`
        })
        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(acceptance).toHaveBeenCalledTimes(1)
      } finally {
        original.resolve({ state: 'unknown', reason: 'cleanup' })
        nested.resolve()
        await Promise.allSettled([sending, settlement, observed])
        acceptance.mockRestore()
      }
    }
  )

  it('persists an echo received while the provider is closing', async () => {
    dispatch.mockResolvedValueOnce({ state: 'unknown', reason: 'ack timeout' })
    const params = sendParams('received just before shutdown')
    await host.send(CALLER, params)
    await handedOver(params.envelope.clientOperationId)
    await vi.waitFor(async () =>
      expect(await submissions()).toMatchObject([{ dispatchState: 'unknown' }])
    )
    let settlement: Promise<void> | undefined
    closeSession.mockImplementationOnce(async () => {
      settlement = host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: params.envelope.clientOperationId,
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'closing-echo' }
      })
      void settlement.catch(() => undefined)
      return true
    })

    await host.close(SESSION, 'evict')
    await expect(settlement).resolves.toBeUndefined()
    await host.revealSession(SESSION)
    expect(await submissions()).toMatchObject([{ dispatchState: 'accepted' }])
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('moves a durable unknown to accepted so nothing offers to send it again', async () => {
    dispatch.mockRejectedValueOnce(new Error('socket closed'))
    const params = sendParams('sent while a turn was running')
    await host.send(CALLER, params)
    await handedOver(params.envelope.clientOperationId)
    await vi.waitFor(async () =>
      expect(await submissions()).toMatchObject([{ dispatchState: 'unknown' }])
    )

    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'late-uuid' }
    })

    expect(await submissions()).toMatchObject([
      { clientMessageId: params.envelope.clientOperationId, dispatchState: 'accepted' }
    ])
    // Retry previously redelivered; the settled send must remain single-dispatch.
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('settles a provider-cancelled queued send as rejected', async () => {
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const params = sendParams('queued behind the active turn')
    await host.send(CALLER, params)
    await handedOver(params.envelope.clientOperationId)

    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
    })
    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'late-echo' }
    })

    expect(await submissions()).toMatchObject([
      {
        clientMessageId: params.envelope.clientOperationId,
        dispatchState: 'rejected',
        reason: DISPATCH_REJECTED_CANCELLED,
        rejection: { kind: 'cancelled' }
      }
    ])
  })

  it('a receipt after Stop withdrew an unwritten send keeps it cancelled', async () => {
    dispatch.mockImplementationOnce(
      (input) =>
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener('abort', () => reject(input.signal?.reason), {
            once: true
          })
        })
    )
    const params = sendParams('stopped before its write')
    await host.send(CALLER, params)
    await handedOver(params.envelope.clientOperationId)
    expect(dispatch.mock.calls[0]?.[0].signal).toBeDefined()

    const stopped = await host.cancel(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: SESSION,
          fields: {}
        })
      }
    })
    expect(stopped).toMatchObject({ ok: true })
    await vi.waitFor(async () =>
      expect(await submissions()).toMatchObject([{ dispatchState: 'rejected' }])
    )
    const before = journal().cursor()
    await host.settleLateDispatch({
      sessionId: SESSION,
      clientMessageId: params.envelope.clientOperationId,
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
    })

    const after = journal().readSince(before)
    expect(after.ok && after.rows.filter((row) => row.kind === 'dispatch')).toEqual([])

    expect(await submissions()).toMatchObject([
      {
        clientMessageId: params.envelope.clientOperationId,
        dispatchState: 'rejected',
        rejection: { kind: 'cancelled' }
      }
    ])
  })

  it('accepts from the durable echo row when the direct settlement write fails', async () => {
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const params = sendParams('settle from provider echo')
    await host.send(CALLER, params)
    await handedOver(params.envelope.clientOperationId)
    vi.spyOn(journal(), 'acceptLate').mockRejectedValueOnce(
      new Error('direct settlement write failed')
    )

    await expect(
      host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: params.envelope.clientOperationId,
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'echo-row' }
      })
    ).rejects.toThrow('direct settlement write failed')
    await journal().appendItem(
      { provider: 'claude', sessionId: THREAD, uuid: 'echo-row' },
      params.body,
      {
        fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )

    expect(await submissions()).toMatchObject([
      {
        clientMessageId: params.envelope.clientOperationId,
        dispatchState: 'accepted',
        providerItemId: `claude:${THREAD}:echo-row`
      }
    ])
  })

  it('leaves an already accepted send alone, adding no row', async () => {
    dispatch.mockResolvedValueOnce({ state: 'admitted' })
    const params = sendParams('ordinary send')
    await host.send(CALLER, params)
    await handedOver(params.envelope.clientOperationId)
    const before = journal().cursor()
    const receipt = (uuid: string) =>
      host.settleLateDispatch({
        sessionId: SESSION,
        clientMessageId: params.envelope.clientOperationId,
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid }
      })

    await Promise.all([receipt('echo-row'), receipt('echo-row')])
    await receipt('a-different-uuid')

    const after = journal().readSince(before)
    expect(after.ok && after.rows.filter((row) => row.kind === 'dispatch')).toMatchObject([
      { state: 'accepted', providerItemId: `claude:${THREAD}:echo-row` }
    ])
  })

  it('ignores a session this host is not holding', async () => {
    await expect(
      host.settleLateDispatch({
        sessionId: 'session-that-is-not-attached',
        clientMessageId: 'whatever',
        providerIdentity: { provider: 'claude', sessionId: THREAD, uuid: 'x' }
      })
    ).resolves.toBeUndefined()
  })
})
