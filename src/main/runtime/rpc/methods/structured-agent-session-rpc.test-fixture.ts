import { statusFeed } from './structured-agent-session-rpc-status.test-fixture'
export { STATUS_SESSION, STATUS_ITEMS } from './structured-agent-session-rpc-status.test-fixture'
import {
  SESSION,
  FINGERPRINT,
  OPERATION,
  request
} from './structured-agent-session-rpc-client.test-fixture'
import { availableRevealWorkspace } from '../../session-tabs/structured-workspace-authority.test-fixture'
import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { vi } from 'vitest'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import {
  getStructuredAgentSessionHost,
  setStructuredAgentSessionHost
} from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionStatusSubscriber } from '../../../native-chat/agent-session-wire/structured-agent-session-status-feed'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcAnyMethodDeclaration, RpcContext, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import { recordingStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { resetStructuredAgentSessionClosesBeforeCreateForTests } from './structured-agent-session-close-before-create'
// Share one dispatcher harness; repopulate stable hostCalls/runtimeCalls objects per test so imports keep their identities.

export const hostCalls: Record<string, ReturnType<typeof vi.fn>> = {}
export const runtimeCalls: Record<string, ReturnType<typeof vi.fn>> = {}

function reset(record: Record<string, ReturnType<typeof vi.fn>>): void {
  for (const key of Object.keys(record)) {
    delete record[key]
  }
}

export function hostStub(): StructuredAgentSessionHost {
  reset(hostCalls)
  Object.assign(hostCalls, {
    attach: vi.fn(async () => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-a', sequence: 0 },
      value: {
        sessionId: SESSION,
        fence: 1,
        page: {
          sessionId: SESSION,
          epoch: 'epoch-a',
          direction: 'tail',
          items: [],
          removedItemIds: [],
          submissions: [],
          window: { oldest: null, newest: null, nextCursor: { epoch: 'epoch-a', sequence: 0 } },
          liveCursor: { epoch: 'epoch-a', sequence: 0 },
          hasOlder: false,
          hasNewer: false
        },
        unconfirmedClientMessageIds: []
      }
    })),
    rewind: vi.fn(async () => ({ ok: true, value: { itemId: 'chosen', epoch: 'next' } })),
    send: vi.fn(async () => ({
      ok: true,
      replayed: false,
      fence: 1,
      cursor: { epoch: 'epoch-a', sequence: 1 },
      value: {
        clientMessageId: OPERATION,
        submission: {
          clientMessageId: OPERATION,
          fence: 1,
          payloadFingerprint: FINGERPRINT,
          dispatchState: 'accepted',
          providerItemId: 'provider-1',
          reason: null,
          submittedAt: 1,
          resolvedAt: 2
        }
      }
    })),
    waitForSendSettlement: vi.fn(),
    queuedMessageMove: vi.fn(async () => ({
      ok: true,
      value: { messageId: 'queued-1', status: 'moved' }
    })),
    cancel: vi.fn(async () => ({ ok: true, replayed: false })),
    close: vi.fn(async () => undefined),
    sleepWorkspace: vi.fn(async () => ({ stoppedSessionIds: [SESSION] })),
    revealSession: vi.fn(async () => ({
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      agent: 'codex' as const,
      readable: true
    })),
    getSessionTabId: vi.fn(() => null),
    setSessionTabVisibility: vi.fn(async () => undefined),
    respondToPrompt: vi.fn(async () => ({ ok: true, replayed: false })),
    setOption: vi.fn(async () => ({ ok: true, replayed: false })),
    changeThreadGoal: vi.fn(async () => ({ ok: true, replayed: false })),
    supportsCreate: vi.fn(() => true),
    handoffStatus: vi.fn(async () => ({ owner: 'native' })),
    readOptions: vi.fn(async () => ({
      models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
      current: { model: 'gpt-live' }
    })),
    history: vi.fn(() => ({ ok: true, page: { items: [] } })),
    sessionAgent: vi.fn(() => null),
    journalSnapshot: vi.fn((sessionId: string) => ({
      sessionId,
      cursor: { epoch: 'epoch-a', sequence: 0 },
      items: [],
      submissions: []
    })),
    subscribe: vi.fn(() => () => undefined),
    // Use a real projected feed rather than restating its shape in the stub.
    subscribeStatus: vi.fn((subscriber: StructuredAgentSessionStatusSubscriber) =>
      statusFeed().subscribe(subscriber)
    ),
    subscribeTurnCompletions: vi.fn(() => () => undefined),
    unsubscribe: vi.fn()
  })
  const store = {
    getOperationRow: vi.fn(() => null),
    getRecord: vi.fn(() => null),
    getConversation: vi.fn(() => null)
  }
  // Not a call: the logger the host hands a runtime caller that reports for it.
  Reflect.set(hostCalls, 'deps', { logger: recordingStructuredAgentSessionLogger().logger, store })
  return hostCalls as unknown as StructuredAgentSessionHost
}

export function dispatcher(
  runtimeOverrides: Record<string, unknown> = {},
  methods: readonly RpcAnyMethodDeclaration[] = STRUCTURED_AGENT_SESSION_METHODS
): RpcDispatcher {
  reset(runtimeCalls)
  Object.assign(runtimeCalls, {
    getStructuredAgentSessionCreateSupport: vi.fn(async () => ({ supported: true })),
    structuredAgentSessionLaunchSeedOptions: vi.fn(() => undefined),
    resolveStructuredAgentSessionCreateIntent: vi.fn(async (params) => ({
      envelope: params.envelope,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: params.agent,
      agent: params.agent,
      accountHome: {
        variable: params.agent === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
        path: params.agent === 'claude' ? '/host/.claude' : '/host/.codex'
      },
      options:
        params.agent === 'claude'
          ? { model: 'opus', effort: 'high' }
          : { model: 'gpt-5.6-sol', effort: 'medium' },
      runtimeKind: 'native'
    })),
    prepareStructuredAgentSessionRevealWorkspace: vi.fn(availableRevealWorkspace),
    currentLocalStructuredSessionPresentation: vi.fn(() => null),
    captureStructuredAgentSessionPresentation: vi.fn(() => ({ raw: null, saved: [] })),
    removeCapturedStructuredSessionSavedTabs: vi.fn(),
    publishStructuredAgentSessionTab: vi.fn<OrcaRuntimeService['publishStructuredAgentSessionTab']>(
      async (input) => input.capture?.({ tableId: null, presentation: { raw: null, saved: [] } })
    )
  })
  const runtime = {
    structuredAgentModelCatalog: async () => getStructuredAgentSessionHost()?.deps.modelCatalog,
    getRuntimeId: () => 'runtime-1',
    readPairedDeviceName: () => null,
    getClientSettings: () => ({ nativeChatProviders: EVERY_AGENT_CHAT }),
    // The host reads saved settings privately; follow the client settings each test chose.
    requireStore: () => ({ getSettings: () => runtime.getClientSettings() }),
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    cleanupSubscriptionsByPrefix: vi.fn(),
    ...runtimeCalls,
    ...runtimeOverrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this partial runtime supplies the dispatcher methods under test and runtimeOverrides; a missing access fails the test.
  return new RpcDispatcher({ runtime: runtime as unknown as OrcaRuntimeService, methods })
}

/** Reply transport carries the negotiated client identity the capability gate reads. */
export async function call(
  method: string,
  params: unknown,
  client?: Pick<
    RpcContext,
    'clientId' | 'connectionId' | 'clientKind' | 'clientCapabilities' | 'signal'
  >,
  runtimeOverrides: Record<string, unknown> = {},
  methods?: readonly RpcAnyMethodDeclaration[]
): Promise<RpcResponse> {
  const replies = await openStream(method, params, client, runtimeOverrides, methods)
  const first = replies[0]
  if (!first) {
    throw new Error(`no reply for ${method}`)
  }
  return first
}

/** For a stream that opens with nothing to say: every reply it sent, possibly none. */
export async function openStream(
  method: string,
  params: unknown,
  client: Parameters<typeof call>[2],
  runtimeOverrides: Record<string, unknown> = {},
  methods?: readonly RpcAnyMethodDeclaration[]
): Promise<RpcResponse[]> {
  const replies: RpcResponse[] = []
  await dispatcher(runtimeOverrides, methods).dispatchStreaming(
    request(method, params),
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    client
  )
  return replies
}

export {
  SESSION,
  FINGERPRINT,
  OPERATION,
  envelope,
  sendParams,
  attachParams,
  STRUCTURED_CLIENT,
  STRUCTURED_MOBILE_CLIENT
} from './structured-agent-session-rpc-client.test-fixture'

/** Every suite wants the same lifecycle: a fresh stub per test, no host left installed. */
export function installStructuredHostStub(): void {
  // A switch-on close remembers the session, refusing its later create; each test starts clean.
  resetStructuredAgentSessionClosesBeforeCreateForTests()
  setStructuredAgentSessionHost(hostStub())
}

export const clearStructuredHostStub = (): void => setStructuredAgentSessionHost(null)
