import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi, type Mock } from 'vitest'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type {
  AgentSessionAcquisition,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import {
  claudeAndCodexDeclared,
  NO_STRUCTURED_AGENTS
} from './structured-agent-session-adapter-router-test-support'
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
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentSessionStartupLimits } from './structured-agent-session-startup-attempt-contract'

export const CALLER = { callerKey: 'client-1' }

export const eventually = (assertion: () => void | Promise<void>, interval = 0): Promise<void> =>
  vi.waitFor(assertion, { timeout: 10_000, interval })

let root: string
export let store: AgentSessionRecordStore
export let host: StructuredAgentSessionHost
export let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
export let dispatch: Mock<StructuredAgentSessionAdapter['dispatch']>
export let closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let setOption: Mock<StructuredAgentSessionAdapter['setOption']>
export const providerStarted: Mock = vi.fn()
export const recordLiveListing: Mock = vi.fn()
const openGates = new Map<string, (model: string) => void>()

export async function proveOpen(model = 'default'): Promise<void> {
  const generation = `generation-${acquire.mock.calls.length}`
  await eventually(() => expect(openGates.has(generation)).toBe(true))
  openGates.get(generation)!(model)
  openGates.delete(generation)
}

export function acquisition(input: StructuredAgentSessionAcquireInput): AgentSessionAcquisition {
  return {
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: input.spawnToken
    },
    acquisitionGeneration: `generation-${acquire.mock.calls.length}`,
    link: {
      linkId: `link-${input.fence}`,
      handle: codexProviderHandle(THREAD),
      origin: store.getRecord(SESSION)?.providerHandleChain.length ? 'resumed' : 'created',
      mintedAtFence: input.fence,
      observedAt: NOW
    }
  }
}

export const publishFirst: StructuredAgentSessionAdapter['acquire'] = async (input) =>
  acquisition(input)

type StartupHostOptions = {
  startupLimits?: Partial<StructuredAgentSessionStartupLimits>
  supportsGoals?: boolean
}

async function startHost({ startupLimits, supportsGoals }: StartupHostOptions = {}): Promise<void> {
  host = new StructuredAgentSessionHost({
    agents: supportsGoals ? claudeAndCodexDeclared() : NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: {
      open: ({ acquisitionGeneration }) =>
        new Promise((resolve) => {
          openGates.set(acquisitionGeneration!, (model) =>
            resolve({ reportedOptions: { model, reportedPermissionMode: 'ask' } })
          )
        }),
      acquire,
      dispatch,
      closeSession,
      releaseAcquisition: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => ({ cancelled: false })),
      answerPrompt: vi.fn(async () => undefined),
      setOption
    },
    modelCatalog: {
      peek: () => null,
      read: vi.fn(async () => ({ origin: 'unknown' as const })),
      recordLiveListing,
      retainedLiveModelIds: vi.fn(async () => []),
      prewarm: vi.fn(async () => {}),
      stop: vi.fn(),
      providerStarted
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${acquire.mock.calls.length}`,
    idleSweep: { intervalMs: 60 * 60_000, idleMs: 60 * 60_000 },
    ...(startupLimits === undefined ? {} : { startupLimits }),
    now: () => NOW
  })
}

export async function restartWith(
  next: StructuredAgentSessionAdapter['acquire'],
  options: StartupHostOptions = {}
): Promise<void> {
  await host.close(SESSION, 'evict')
  await host.flushAllStreamedEvents()
  acquire.mockImplementation(next)
  closeSession.mockClear()
  await startHost(options)
  acquire.mockClear()
}

export function registerStartupAttemptHostTests(): void {
  beforeEach(async () => {
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    })
    root = await mkdtemp(join(tmpdir(), 'orca-startup-attempt-'))
    resetHostTestOperationIds()
    providerStarted.mockReset()
    recordLiveListing.mockReset()
    openGates.clear()
    acquire = vi.fn(async (input) => acquisition(input))
    dispatch = vi.fn(async () => ({
      state: 'accepted' as const,
      providerIdentity: {
        provider: 'codex' as const,
        threadId: THREAD,
        turnId: `turn-${dispatch.mock.calls.length}`,
        ordinal: dispatch.mock.calls.length
      }
    }))
    closeSession = vi.fn(async () => true)
    setOption = vi.fn(async () => undefined)
    store = await openTestAgentSessionRecordStore(root)
    await startHost()
    expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  })

  afterEach(async () => {
    try {
      await host.flushAllStreamedEvents()
      await rm(root, { recursive: true, force: true })
    } finally {
      vi.useRealTimers()
    }
  })
}

function sendParams(text: string, clientOperationId = hostTestOperationId()) {
  const body = hostTestMessage(text)
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId,
      expectedRuntimeFence: 1,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  }
}

export async function accept(text: string, clientOperationId?: string): Promise<string> {
  const params = sendParams(text, clientOperationId)
  expect(await host.send(CALLER, params)).toMatchObject({
    ok: true,
    value: { submission: { dispatchState: 'pending', handoverRecorded: true } }
  })
  return params.envelope.clientOperationId
}

export async function submission(id: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === id
  )
}

export async function heldBehindStart(text: string, interval = 0): Promise<string> {
  const id = await accept(text)
  await eventually(
    async () => expect(host.readStatusSummary(SESSION)?.hostExecutionPhase).toBe('starting'),
    interval
  )
  return id
}

export function stop() {
  return host.cancel(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.cancel',
        sessionId: SESSION,
        fields: { turnId: 'turn-none' }
      })
    },
    turnId: 'turn-none'
  })
}
