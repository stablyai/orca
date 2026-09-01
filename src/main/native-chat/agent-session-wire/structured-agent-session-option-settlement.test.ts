import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { AgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
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

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let router: StructuredAgentSessionAdapter
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let closeNativeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>>
let activeModel: string
let activeEffort: string | null
let transcriptPath: string
let optionFailure: Error | null
let tuiLaunchFailure: Error | null
/** What the adapter's closeSession reports about the child's exit. */
let closeSessionExit = true
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
      if (tuiLaunchFailure) {
        const error = tuiLaunchFailure
        tuiLaunchFailure = null
        throw error
      }
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
  closeNativeSession = vi.fn(async () => {
    activeModel = DEFAULT_MODEL
    return closeSessionExit
  })
  return {
    supportsLocation: () => true,
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
    closeSession: closeNativeSession
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-handoff-options-'))
  resetHostTestOperationIds()
  activeModel = DEFAULT_MODEL
  activeEffort = null
  optionFailure = null
  tuiLaunchFailure = null
  closeSessionExit = true
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
  router = adapter()
  host = new StructuredAgentSessionHost({
    store,
    adapter: router,
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

describe('structured session options and close', () => {
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

  // Closing a chat used to leave its provider child resident for the whole app session: the host's
  // session map had no delete and the only teardown was app quit.
  it('stops the provider child and forgets the session when the chat closes', async () => {
    expect(host.hasSession(SESSION)).toBe(true)

    await host.close(SESSION)

    expect(closeNativeSession).toHaveBeenCalledWith(SESSION)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'exit-observed' }
    })
    expect(host.hasSession(SESSION)).toBe(false)

    await expect(host.close(SESSION)).resolves.toBeUndefined()
    expect(closeNativeSession).toHaveBeenCalledOnce()
  })

  it('is a no-op for a session it does not hold', async () => {
    await host.close(SESSION)
    closeNativeSession.mockClear()

    await expect(host.close(SESSION)).resolves.toBeUndefined()
    expect(closeNativeSession).not.toHaveBeenCalled()
  })
})
