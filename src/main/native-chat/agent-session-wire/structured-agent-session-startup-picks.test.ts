// Picks made while an agent starts are applied before its start is accepted, under its startup
// clock. A pick the agent refuses is shown as what it runs; one cut short by the limit or a Stop
// leaves the start unproven, so no child ever runs a model the chat does not show.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'

const CALLER = { callerKey: 'desktop' }
const SILENCE_MS = 10_000

let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquires = 0
let phases: (string | undefined)[]
const setOption = vi.fn<StructuredAgentSessionAdapter['setOption']>()
const dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>()
const closeSession = vi.fn(async () => true)

beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
  })
  resetHostTestOperationIds()
  acquires = 0
  phases = []
  setOption.mockReset().mockResolvedValue(undefined)
  dispatch.mockReset().mockResolvedValue({ state: 'unknown', reason: 'unused' })
  closeSession.mockClear()
  directory = await mkdtemp(join(tmpdir(), 'orca-startup-picks-'))
  store = await openTestAgentSessionRecordStore(directory)
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      supportsCreate: (_location, agent) => agent === 'codex',
      supportsLocation: () => true,
      acquire: async (input) => {
        acquires += 1
        return {
          process: {
            hostId: 'local',
            pid: 4000 + acquires,
            processStartTimeMs: HOST_TEST_NOW,
            spawnToken: input.spawnToken
          },
          acquisitionGeneration: `generation-${acquires}`,
          link: {
            linkId: `link-${acquires}`,
            mintedAtFence: input.fence,
            observedAt: HOST_TEST_NOW,
            origin: acquires === 1 ? 'created' : 'resumed',
            handle: codexProviderHandle(THREAD)
          }
        }
      },
      dispatch,
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => {},
      setOption,
      releaseAcquisition: async () => true,
      closeSession
    },
    journalDatabase: openTestJournalHostDatabase(directory),
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    probeOwner: async () => ({ outcome: 'exit-observed' }),
    idleSweep: { intervalMs: 3_600_000 },
    startupLimits: { silenceMs: SILENCE_MS, ceilingMs: 10 * SILENCE_MS }
  })
  host.subscribeStatus({
    id: 'phases',
    emit: (event) => {
      if (event.type === 'status' && event.session.sessionId === SESSION) {
        phases.push(event.session.hostExecutionPhase)
      }
    }
  })
  const attach = hostTestAttachParams(null)
  expect(
    await host.attach(CALLER, { ...attach, options: { model: 'launched-model' } })
  ).toMatchObject({ ok: true })
})

afterEach(async () => {
  vi.useRealTimers()
  await host.flushAllStreamedEvents()
  await rm(directory, { recursive: true, force: true })
})

function envelope(method: string, fields: Record<string, unknown>): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

async function pick(model: string): Promise<void> {
  const fields = { key: 'model', value: model }
  expect(
    await host.setOption(CALLER, {
      envelope: envelope('agentSession.setOption', fields),
      ...fields
    })
  ).toMatchObject({ ok: true })
}

async function sendHeld(text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  return sent.value.clientMessageId
}

/** The child reports its start, as an adapter does once its protocol session answers. */
function started(reportedModel = 'launched-model'): Promise<void> {
  return host.handleAdapterEvent({
    type: 'started',
    sessionId: SESSION,
    fence: store.getRecord(SESSION)!.lease.runtimeFence,
    acquisitionGeneration: `generation-${acquires}`,
    reportedOptions: { model: reportedModel },
    restoreSkippedOptions: [],
    optionRevision: 0
  })
}

/** A write that never answers on its own: only its abort ends it. */
function writeHeldUntilAborted(): void {
  setOption.mockImplementation(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
  )
}

async function dispatchState(clientMessageId: string) {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )?.dispatchState
}

it('shows what the agent runs when it refuses a pick made while it started', async () => {
  await pick('picked-model')
  expect(store.getRecord(SESSION)?.options?.model).toBe('picked-model')
  setOption.mockRejectedValueOnce(new Error('model not available'))

  await started()

  expect(setOption).toHaveBeenCalledWith(expect.objectContaining({ value: 'picked-model' }))
  expect(store.getRecord(SESSION)?.options?.model).toBe('launched-model')
  expect(phases.at(-1)).toBe('ready')
})

it('never accepts a start whose limit passes while a pick is applying; the pick stays for the next start', async () => {
  const held = await sendHeld('held while starting')
  await pick('picked-model')
  writeHeldUntilAborted()

  const proving = started()
  await vi.waitFor(() => expect(setOption).toHaveBeenCalledOnce())
  await vi.advanceTimersByTimeAsync(SILENCE_MS)
  await proving

  await vi.waitFor(async () => expect(await dispatchState(held)).toBe('rejected'))
  expect(closeSession).toHaveBeenCalled()
  expect(phases).not.toContain('ready')
  expect(dispatch).not.toHaveBeenCalled()
  expect(store.getRecord(SESSION)?.options?.model).toBe('picked-model')
})

it('never accepts a start whose limit passed before its proof was settled', async () => {
  const held = await sendHeld('held while starting')
  await pick('picked-model')
  const { serialize } = host.collaboratorsForTests()
  const lane = Promise.withResolvers<void>()
  const blocked = serialize(SESSION, () => lane.promise)

  const proving = started()
  await vi.advanceTimersByTimeAsync(SILENCE_MS)
  lane.resolve()
  await blocked
  await proving

  await vi.waitFor(async () => expect(await dispatchState(held)).toBe('rejected'))
  expect(setOption).not.toHaveBeenCalled()
  expect(phases).not.toContain('ready')
  expect(dispatch).not.toHaveBeenCalled()
})

it('ends a start a Stop cuts short while it applies a pick, never showing it ready', async () => {
  await pick('picked-model')
  writeHeldUntilAborted()

  const proving = started()
  await vi.waitFor(() => expect(setOption).toHaveBeenCalledOnce())
  expect(
    await host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
  ).toMatchObject({ ok: true })
  await proving

  await vi.waitFor(() => expect(closeSession).toHaveBeenCalled())
  expect(phases).not.toContain('ready')
  expect(store.getRecord(SESSION)?.options?.model).toBe('picked-model')
})
