import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type {
  AgentSessionHandoffDirection,
  AgentSessionHandoffRequest,
  AgentSessionMutationEnvelope
} from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { AgentSessionOptionRejectedError } from './structured-agent-session-option-error'
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
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

const CALLER = { callerKey: 'client-1' }
const DEFAULT_MODEL = 'gpt-default'
const PICKED_MODEL = 'gpt-picked'
const PICKED_EFFORT = 'medium'

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let activeModel: string
let activeEffort: string | null
let transcriptPath: string
let optionFailure: Error | null
const dispatchedModels: string[] = []
const launchedOptions: (Readonly<Record<string, string>> | undefined)[] = []
const closedTuiOwners: StructuredTuiOwner[] = []

function envelope(method: string, fields: Record<string, unknown>): AgentSessionMutationEnvelope {
  return {
    sessionId: SESSION,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? null,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  }
}

function handoff(direction: AgentSessionHandoffDirection): AgentSessionHandoffRequest {
  const fields = { direction, mode: 'now' as const, action: 'start' as const }
  return { envelope: envelope('agentSession.requestHandoff', fields), ...fields }
}

function tuiOwner(fence: number, spawnToken: string): StructuredTuiOwner {
  return {
    terminal: { handle: 'term-tui', tabId: 'tab-tui', paneKey: 'pane-tui', ptyId: 'pty-tui' },
    process: {
      hostId: 'local',
      pid: 5200,
      processStartTimeMs: NOW,
      spawnToken
    },
    link: {
      linkId: `tui-link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: 'resumed',
      mintedAtFence: fence,
      observedAt: NOW
    },
    transcriptPath
  }
}

function handoffTransport(): StructuredAgentSessionHandoffTransport {
  return {
    hostLabel: 'Test host',
    launchTui: async ({ record, fence, spawnToken }) => {
      launchedOptions.push(record.options)
      return tuiOwner(fence, spawnToken)
    },
    reproveTuiOwner: async ({ owner }) => owner,
    recoverTuiOwner: async (record) =>
      tuiOwner(
        record.lease.runtimeFence,
        record.lease.ownerProcess?.spawnToken ?? record.lease.reservedSpawnToken ?? 'recovered'
      ),
    stopRecoveredOwner: async () => undefined,
    closeTuiOwner: async (owner) => {
      closedTuiOwners.push(owner)
      return { transcriptPath: owner.transcriptPath }
    },
    waitForTuiExit: async (owner) => ({ transcriptPath: owner.transcriptPath }),
    waitForTuiIdleOrExit: async () => 'idle',
    tuiStatus: () => 'idle'
  }
}

function adapter(): StructuredAgentSessionAdapter {
  acquire = vi.fn(async ({ fence, spawnToken, options }) => {
    activeModel = options?.model ?? DEFAULT_MODEL
    activeEffort = options?.effort ?? null
    return {
      process: {
        hostId: 'local',
        pid: 4200 + acquire.mock.calls.length,
        processStartTimeMs: NOW,
        spawnToken
      },
      link: {
        linkId: `native-link-${fence}`,
        handle: { provider: 'codex', threadId: THREAD },
        origin: acquire.mock.calls.length === 1 ? 'created' : 'resumed',
        mintedAtFence: fence,
        observedAt: NOW
      }
    }
  })
  return {
    acquire,
    dispatch: vi.fn<StructuredAgentSessionAdapter['dispatch']>(async () => {
      dispatchedModels.push(activeModel)
      return {
        state: 'accepted',
        providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 }
      }
    }),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: vi.fn(async () => undefined),
    setOption: vi.fn(async ({ key, value }) => {
      if (optionFailure) {
        const error = optionFailure
        optionFailure = null
        throw error
      }
      if (key === 'model') {
        activeModel = value
      } else if (key === 'effort') {
        activeEffort = value
      }
      return {
        model: activeModel,
        ...(activeEffort ? { effort: activeEffort } : {})
      }
    }),
    readOptions: vi.fn(async () => ({
      current: { model: activeModel, ...(activeEffort ? { effort: activeEffort } : {}) },
      models: []
    })),
    closeSession: vi.fn(async () => {
      activeModel = DEFAULT_MODEL
      return true
    })
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-handoff-options-'))
  resetHostTestOperationIds()
  activeModel = DEFAULT_MODEL
  activeEffort = null
  optionFailure = null
  dispatchedModels.length = 0
  launchedOptions.length = 0
  closedTuiOwners.length = 0
  const accountHome = join(root, 'codex-home')
  const sessionsDir = join(accountHome, 'sessions', '2026', '08', '12')
  transcriptPath = join(sessionsDir, `rollout-2026-08-12T10-00-00-${THREAD}.jsonl`)
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(
    transcriptPath,
    `${JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-08-12T10:00:00.000Z',
      payload: { id: THREAD, session_id: THREAD }
    })}\n`,
    'utf8'
  )
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-native',
    handoffTransport: handoffTransport(),
    now: () => NOW
  })
  const attached = await host.attach(
    CALLER,
    hostTestAttachParams(null, { accountHome: { variable: 'CODEX_HOME', path: accountHome } })
  )
  expect(attached).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

describe('structured session handoff options', () => {
  it('settles a pre-mutation rejection so a fresh retry can succeed', async () => {
    optionFailure = new AgentSessionOptionRejectedError('model list unavailable')
    const fields = { key: 'model', value: PICKED_MODEL }
    const rejected = {
      envelope: envelope('agentSession.setOption', fields),
      ...fields
    }

    expect(await host.setOption(CALLER, rejected)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid', message: 'model list unavailable' }
    })
    expect(await host.setOption(CALLER, rejected)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(
      await host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', fields),
        ...fields
      })
    ).toMatchObject({ ok: true, value: { options: { model: PICKED_MODEL } } })
    expect(store.getRecord(SESSION)?.options).toEqual({ model: PICKED_MODEL })
  })

  it('keeps a picked model through a native to TUI to native round trip', async () => {
    const optionFields = { key: 'model', value: PICKED_MODEL }
    expect(
      await host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', optionFields),
        ...optionFields
      })
    ).toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.options).toEqual({ model: PICKED_MODEL })

    const effortFields = { key: 'effort', value: PICKED_EFFORT }
    expect(
      await host.setOption(CALLER, {
        envelope: envelope('agentSession.setOption', effortFields),
        ...effortFields
      })
    ).toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.options).toEqual({
      model: PICKED_MODEL,
      effort: PICKED_EFFORT
    })

    expect(await host.requestHandoff(CALLER, handoff('to-tui'))).toMatchObject({ ok: true })
    await vi.waitFor(async () =>
      expect(await host.handoffStatus(SESSION)).toMatchObject({ owner: 'tui' })
    )
    expect(await host.requestHandoff(CALLER, handoff('to-native'))).toMatchObject({ ok: true })
    await vi.waitFor(async () =>
      expect(await host.handoffStatus(SESSION)).toMatchObject({ owner: 'native' })
    )

    expect(launchedOptions).toEqual([{ model: PICKED_MODEL, effort: PICKED_EFFORT }])
    expect(closedTuiOwners).toHaveLength(1)
    expect(acquire.mock.calls[1]?.[0].options).toEqual({
      model: PICKED_MODEL,
      effort: PICKED_EFFORT
    })
    expect(store.getRecord(SESSION)?.options).toEqual({
      model: PICKED_MODEL,
      effort: PICKED_EFFORT
    })
    const body = hostTestMessage('use the selected model')
    expect(
      await host.send(CALLER, {
        envelope: envelope('agentSession.send', { body }),
        body
      })
    ).toMatchObject({ ok: true })
    expect(dispatchedModels).toEqual([PICKED_MODEL])
  })
})
