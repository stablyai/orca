import '../unused-default-rpc-methods.test-fixture'
/**
 * A chat tab's pointer to the conversation it shows, driven end to end: a real record store on disk,
 * the real structured host, the real runtime, and the real RPC handlers. Only the provider is faked.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import type { RpcDispatchStreamingOptions } from '../dispatcher-stream-options'
import { SESSION_TAB_METHODS } from './session-tabs'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import { commitStructuredAgentSessionCreate } from './structured-agent-session-create'
import { openTestJournalHostDatabase } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'
import { codexProviderHandle } from '../../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter-router-test-support'

export const WORKTREE = `id:${HOST_TEST_LOCATION.workspaceId}`
export const SOURCE_TAB = `structured-agent-session-${HOST_TEST_SESSION}`
export const caller = { callerKey: 'trusted-local:runtime' }

export let directory: string
export let store: AgentSessionRecordStore
export let host: StructuredAgentSessionHost
export let runtime: OrcaRuntimeService
export let dispatcher: RpcDispatcher
export let acquisitions = 0
let acquireFails = false

export function setAcquireFailure(fails: boolean): void {
  acquireFails = fails
}
export let closeSession: ReturnType<typeof vi.fn<() => Promise<boolean>>>

function providerAdapter(): StructuredAgentSessionAdapter {
  return {
    supportsLocation: (location) =>
      location.executionHostId === 'local' && location.wslDistro === null,
    acquire: vi.fn(async (input) => {
      if (acquireFails) {
        throw new Error('provider failed to start')
      }
      acquisitions++
      return {
        process: {
          hostId: 'local',
          pid: 4000 + acquisitions,
          processStartTimeMs: HOST_TEST_NOW,
          spawnToken: input.spawnToken
        },
        link: {
          linkId: `link-${acquisitions}`,
          mintedAtFence: input.fence,
          observedAt: HOST_TEST_NOW,
          origin: 'created' as const,
          handle: codexProviderHandle(
            `00000000-0000-4000-8000-${String(acquisitions).padStart(12, '0')}`
          )
        }
      }
    }),
    dispatch: vi.fn(async () => ({ state: 'admitted' as const })),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: async () => {},
    setOption: async () => {},
    releaseAcquisition: async () => true,
    closeSession,
    readOptions: async () => ({ models: [], current: { model: 'test-model', effort: 'high' } })
  }
}

export async function openHost(): Promise<void> {
  store = await openTestAgentSessionRecordStore(directory)
  host = new StructuredAgentSessionHost({
    agents: NO_STRUCTURED_AGENTS,
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: providerAdapter(),
    journalDatabase: openTestJournalHostDatabase(directory),
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    mintSpawnToken: () => `spawn-${acquisitions}`
  })
  setStructuredAgentSessionHost(host)
}

type CallResponse = {
  ok: boolean
  result?: { ok?: boolean; value?: { replacementSessionId?: string } }
}

export async function call(
  method: string,
  params: unknown,
  context: RpcDispatchStreamingOptions = {}
): Promise<CallResponse> {
  const response = await dispatcher.dispatch(
    { id: 'request', authToken: 'token', method, params },
    context
  )
  return JSON.parse(JSON.stringify(response))
}

export async function createChat(sessionId: string, tabId?: string) {
  return commitStructuredAgentSessionCreate({
    runtime,
    caller,
    activate: true,
    prepared: {
      host,
      attachParams: hostTestAttachParams(null, {
        envelope: {
          sessionId,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: ''
        },
        ...(tabId ? { surfaceTabId: tabId } : {})
      }),
      tab: { workspaceId: HOST_TEST_LOCATION.workspaceId, agent: 'codex' }
    }
  })
}

export function envelopeFor(method: string, sessionId: string, fields: Record<string, unknown>) {
  return {
    sessionId,
    clientOperationId: hostTestOperationId(),
    expectedRuntimeFence: store.getRecord(sessionId)!.lease.runtimeFence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({ method, sessionId, fields })
  }
}

export async function clear(
  sessionId: string,
  context: RpcDispatchStreamingOptions = {}
): Promise<string> {
  const response = await call(
    'agentSession.conversationCommand',
    {
      command: 'clear',
      envelope: envelopeFor('agentSession.conversationCommand', sessionId, { command: 'clear' })
    },
    context
  )
  expect(response).toMatchObject({ ok: true, result: { ok: true } })
  const replacement = response.result?.value?.replacementSessionId
  expect(replacement).toBeUndefined()
  return sessionId
}

export async function send(sessionId: string, text: string) {
  const body = hostTestMessage(text)
  return call('agentSession.send', {
    body,
    envelope: envelopeFor('agentSession.send', sessionId, { body })
  })
}

export async function snapshot() {
  return runtime.listMobileSessionTabs(WORKTREE)
}

beforeEach(async () => {
  resetHostTestOperationIds()
  acquisitions = 0
  acquireFails = false
  closeSession = vi.fn(async () => true)
  directory = await mkdtemp(join(tmpdir(), 'orca-chat-tab-table-'))
  runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'getClientSettings').mockReturnValue(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the structured-chat policy reads only this one setting on these paths.
    { experimentalNativeChat: true } as ReturnType<OrcaRuntimeService['getClientSettings']>
  )
  dispatcher = new RpcDispatcher({
    runtime,
    methods: [...STRUCTURED_AGENT_SESSION_METHODS, ...SESSION_TAB_METHODS]
  })
  await openHost()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await host?.flushAllStreamedEvents()
  setStructuredAgentSessionHost(null)
  await rm(directory, { recursive: true, force: true })
})
