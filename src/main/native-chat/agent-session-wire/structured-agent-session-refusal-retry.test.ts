import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS } from '../../../shared/agent-session-host-authority'
import { AGENT_SESSION_DURABLE_OPERATION_PER_CLIENT_LIMIT } from '../../../shared/agent-session-operation-ledger'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  AGENT_SESSION_WIRE_REFUSAL_CODES,
  type AgentSessionMutationEnvelope,
  type AgentSessionMutationResult,
  type AgentSessionWireRefusalCode
} from '../../../shared/agent-session-wire'
import {
  agentSessionRefusalOperationState,
  type AgentSessionRefusalOperationState
} from '../../../shared/agent-session-refusal-retry'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import type { StructuredAgentSessionHandoffTransport } from './structured-agent-session-handoff-types'

const CALLER = { callerKey: 'client-1' }
const METHODS = ['agentSession.setOption', 'agentSession.send'] as const
type Method = (typeof METHODS)[number]
type Pair = `${Method}:${AgentSessionWireRefusalCode}`

type CallSpec = {
  method: Method
  operationId: string
  expectedRuntimeFence?: number
  payloadFingerprint?: string
}

type Harness = {
  root: string
  store: AgentSessionRecordStore
  host: StructuredAgentSessionHost
  setOption: Mock<StructuredAgentSessionAdapter['setOption']>
}

const harnesses: Harness[] = []
let operationSequence = 1_000

function operationId(timestamp = NOW): string {
  operationSequence += 1
  return `${timestamp}-${operationSequence.toString(16).padStart(32, '0')}`
}

function handoffTransport(): StructuredAgentSessionHandoffTransport {
  const unused = async (): Promise<never> => {
    throw new Error('unused handoff transport')
  }
  return {
    hostLabel: 'test-host',
    launchTui: unused,
    reproveTuiOwner: unused,
    recoverTuiOwner: unused,
    stopRecoveredOwner: async () => undefined,
    waitForTuiExit: unused,
    waitForTuiIdleOrExit: unused,
    tuiStatus: () => 'idle'
  }
}

async function createHarness(options: { attached?: boolean; transport?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orca-refusal-oracle-'))
  const store = await AgentSessionRecordStore.open({
    directory: join(root, 'store'),
    hostId: 'local'
  })
  const setOption = vi.fn<StructuredAgentSessionAdapter['setOption']>(async () => undefined)
  const adapter: StructuredAgentSessionAdapter = {
    acquire: async ({ fence }) => ({
      process: {
        hostId: 'local',
        pid: 4242,
        processStartTimeMs: NOW - 1_000,
        spawnToken: store.getRecord(SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
      },
      link: {
        linkId: `link-${fence}`,
        handle: { provider: 'codex', threadId: THREAD },
        origin: 'created',
        mintedAtFence: fence,
        observedAt: NOW
      }
    }),
    dispatch: async () => ({
      state: 'accepted',
      providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
    }),
    cancelTurn: async () => ({ cancelled: true }),
    answerPrompt: async () => undefined,
    setOption
  }
  const host = new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => NOW,
    ...(options.transport ? { handoffTransport: handoffTransport() } : {})
  })
  const harness = { root, store, host, setOption }
  harnesses.push(harness)
  if (options.attached !== false) {
    expect(await host.attach(CALLER, hostTestAttachParams(null))).toMatchObject({ ok: true })
  }
  return harness
}

afterEach(async () => {
  const completed = harnesses.splice(0)
  await Promise.all(completed.map(async ({ host }) => host.flushAllStreamedEvents()))
  await Promise.all(completed.map(async ({ root }) => rm(root, { recursive: true })))
})

function callFields(spec: CallSpec): Record<string, unknown> {
  if (spec.method === 'agentSession.send') {
    return { body: hostTestMessage('host oracle') }
  }
  return { key: 'model', value: 'gpt-5' }
}

function envelope(harness: Harness, spec: CallSpec): AgentSessionMutationEnvelope {
  const fields = callFields(spec)
  return {
    sessionId: SESSION,
    clientOperationId: spec.operationId,
    expectedRuntimeFence:
      spec.expectedRuntimeFence ?? harness.store.getRecord(SESSION)?.lease.runtimeFence ?? 1,
    payloadFingerprint:
      spec.payloadFingerprint ??
      computeAgentSessionPayloadFingerprint({ method: spec.method, sessionId: SESSION, fields })
  }
}

function invoke(harness: Harness, spec: CallSpec): Promise<AgentSessionMutationResult<unknown>> {
  const fields = callFields(spec)
  const mutationEnvelope = envelope(harness, spec)
  if (spec.method === 'agentSession.send') {
    return harness.host.send(CALLER, {
      envelope: mutationEnvelope,
      body: fields.body as ReturnType<typeof hostTestMessage>
    })
  }
  return harness.host.setOption(CALLER, {
    envelope: mutationEnvelope,
    key: fields.key as string,
    value: fields.value as string
  })
}

function operationState(harness: Harness, operation: string) {
  return harness.store
    .listOperationRows()
    .find((row) => row.callerKey === CALLER.callerKey && row.operationId === operation)?.outcome
}

async function assertHostAgreement(
  harness: Harness,
  spec: CallSpec,
  code: AgentSessionWireRefusalCode,
  retryOnFreshHost = false
): Promise<Pair> {
  try {
    const result = await invoke(harness, spec)
    expect(result, `${spec.method}:${code}`).toMatchObject({ ok: false, refusal: { code } })
  } catch (error) {
    expect(error).toMatchObject({ message: code })
  }
  const outcome = operationState(harness, spec.operationId)
  let oracle: AgentSessionRefusalOperationState
  if (outcome?.status === 'failed') {
    oracle = 'settled-rejected'
  } else if (outcome?.status === 'unknown') {
    oracle = 'unknown'
  } else if (outcome?.status === 'pending') {
    oracle = 'pending-admission'
  } else {
    const retryHarness = retryOnFreshHost ? await createHarness() : harness
    await invoke(retryHarness, spec)
    oracle = operationState(retryHarness, spec.operationId)
      ? 'pending-admission'
      : 'settled-rejected'
  }
  expect(agentSessionRefusalOperationState(spec.method, code), `${spec.method}:${code}`).toBe(
    oracle
  )
  return `${spec.method}:${code}`
}

async function setLease(
  harness: Harness,
  update: (record: AgentSessionRecord) => AgentSessionRecord
): Promise<void> {
  await harness.store.transitionHandoff(SESSION, update)
}

async function fillOperationLedger(harness: Harness): Promise<void> {
  while (
    harness.store.listOperationRows().filter((row) => row.callerKey === CALLER.callerKey).length <
    AGENT_SESSION_DURABLE_OPERATION_PER_CLIENT_LIMIT
  ) {
    await harness.store.admitOperation({
      callerKey: CALLER.callerKey,
      operationId: operationId(),
      fingerprint: 'capacity-fixture',
      now: NOW
    })
  }
}

// sendPlan and setOptionPlan have no unsupported branch; only handoff checked transport.
const UNREACHABLE = new Set<Pair>([
  'agentSession.send:structured_agent_session_unsupported',
  'agentSession.setOption:structured_agent_session_unsupported',
  // performPrompt is the sole producer of prompt revision and resolution refusals.
  'agentSession.setOption:agent_session_item_revision_stale',
  'agentSession.send:agent_session_item_revision_stale',
  'agentSession.setOption:agent_session_already_resolved',
  'agentSession.send:agent_session_already_resolved',
  // StructuredAgentSessionHost.mutate maps an absent record to AGENT_SESSION_NOT_ATTACHED.
  'agentSession.setOption:agent_session_identity_required',
  'agentSession.send:agent_session_identity_required',
  // No structured-agent-session host branch emits agent_session_journal_unreadable.
  'agentSession.setOption:agent_session_journal_unreadable',
  'agentSession.send:agent_session_journal_unreadable'
])

describe('agentSessionRefusalOperationState host oracle', () => {
  // 26 real host round trips, each committing the store — and every commit now also rotates a
  // durable backup, so this does substantially more fsync work than the budget was set for.
  it('agrees with every refusal the real host path can produce', { timeout: 90_000 }, async () => {
    const produced = new Set<Pair>()
    const record = (pair: Pair) => produced.add(pair)

    const stale = await createHarness()
    for (const method of METHODS) {
      record(
        await assertHostAgreement(
          stale,
          {
            method,
            operationId: operationId(),
            expectedRuntimeFence: 99
          },
          'agent_session_checkpoint_stale'
        )
      )
    }

    const conflict = await createHarness({ transport: true })
    await setLease(conflict, (current) => ({
      ...current,
      lease: { ...current.lease, runtimeKind: 'tui' }
    }))
    for (const method of ['agentSession.setOption', 'agentSession.send'] as const) {
      record(
        await assertHostAgreement(
          conflict,
          { method, operationId: operationId() },
          'agent_session_conflict'
        )
      )
    }

    const absent = await createHarness({ attached: false })
    for (const method of METHODS) {
      record(
        await assertHostAgreement(
          absent,
          { method, operationId: operationId() },
          'agent_session_ownership_unknown',
          true
        )
      )
    }

    const operationConflict = await createHarness()
    for (const method of ['agentSession.setOption', 'agentSession.send'] as const) {
      record(
        await assertHostAgreement(
          operationConflict,
          {
            method,
            operationId: operationId(),
            payloadFingerprint: 'wrong'
          },
          'agent_session_operation_conflict'
        )
      )
    }
    const ledgerRefusals = await createHarness()
    for (const [code, timestamp] of [
      ['agent_session_operation_expired', NOW - AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS - 1],
      ['agent_session_operation_invalid', null]
    ] as const) {
      for (const method of METHODS) {
        record(
          await assertHostAgreement(
            ledgerRefusals,
            {
              method,
              operationId: timestamp === null ? 'invalid-operation-id' : operationId(timestamp)
            },
            code
          )
        )
      }
    }

    const capacity = await createHarness()
    await fillOperationLedger(capacity)
    for (const method of METHODS) {
      record(
        await assertHostAgreement(
          capacity,
          { method, operationId: operationId() },
          'agent_session_operation_capacity',
          true
        )
      )
    }

    const unknown = await createHarness()
    unknown.setOption.mockRejectedValueOnce(new Error('reply lost'))
    const optionUnknown = { method: 'agentSession.setOption' as const, operationId: operationId() }
    await expect(invoke(unknown, optionUnknown)).rejects.toThrow('reply lost')
    record(await assertHostAgreement(unknown, optionUnknown, 'agent_session_operation_unknown'))

    const appendFailure = vi
      .spyOn(AgentSessionJournal.prototype, 'appendSubmission')
      .mockRejectedValueOnce(new Error('journal write failed'))
    const sendUnknown = { method: 'agentSession.send' as const, operationId: operationId() }
    await expect(invoke(unknown, sendUnknown)).rejects.toThrow('journal write failed')
    appendFailure.mockRestore()
    record(await assertHostAgreement(unknown, sendUnknown, 'agent_session_operation_unknown'))

    const reconciling = await createHarness()
    await setLease(reconciling, (current) => ({
      ...current,
      lease: { ...current.lease, unreconciled: true }
    }))
    for (const method of ['agentSession.setOption', 'agentSession.send'] as const) {
      record(
        await assertHostAgreement(
          reconciling,
          { method, operationId: operationId() },
          'execution_owner_reconciling'
        )
      )
    }

    const allPairs = METHODS.flatMap((method) =>
      AGENT_SESSION_WIRE_REFUSAL_CODES.map((code) => `${method}:${code}` as Pair)
    )
    expect(new Set([...produced, ...UNREACHABLE])).toEqual(new Set(allPairs))
    expect([...produced].filter((pair) => UNREACHABLE.has(pair))).toEqual([])
  })
})
