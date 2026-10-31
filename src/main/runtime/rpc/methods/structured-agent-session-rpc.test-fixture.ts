// Share one dispatcher harness; repopulate stable hostCalls/runtimeCalls objects per test so imports keep their identities.

import { EVERY_AGENT_CHAT } from '../../../../shared/native-chat/every-agent-chat.test-fixture'
import { vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../../../native-chat/agent-session-journal/journal-store'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  StructuredAgentSessionStatusFeed,
  type StructuredAgentSessionStatusSubscriber
} from '../../../native-chat/agent-session-wire/structured-agent-session-status-feed'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcAnyMethodDeclaration, RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger'
import { recordingStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { resetStructuredAgentSessionClosesBeforeCreateForTests } from './structured-agent-session-close-before-create'

export const SESSION = 'session-alpha'
export const FINGERPRINT = 'f'.repeat(64)
export const OPERATION = '1800000000000-00000000000000000000000000000001'

export function envelope(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: SESSION,
    clientOperationId: OPERATION,
    expectedRuntimeFence: 1,
    payloadFingerprint: FINGERPRINT,
    ...overrides
  }
}

export function sendParams(overrides: Record<string, unknown> = {}) {
  return {
    envelope: envelope(),
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
    ...overrides
  }
}

export function attachParams(overrides: Record<string, unknown> = {}) {
  return {
    envelope: envelope({ expectedRuntimeFence: null }),
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    providerHandle: { kind: 'codex', threadId: 'thread-1' },
    ...overrides
  }
}

function request(method: string, params: unknown): RpcRequest {
  return { id: 'request-1', authToken: 'token', method, params }
}

export const hostCalls: Record<string, ReturnType<typeof vi.fn>> = {}
export const runtimeCalls: Record<string, ReturnType<typeof vi.fn>> = {}

function reset(record: Record<string, ReturnType<typeof vi.fn>>): void {
  for (const key of Object.keys(record)) {
    delete record[key]
  }
}

export const STATUS_SESSION = 'session-status'
export const STATUS_ITEMS: AgentJournalRenderItem[] = [
  {
    itemId: 'user-1',
    sequence: 1,
    revision: 1,
    observedAt: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'write a poem' }] }
  },
  {
    itemId: 'turn-1',
    sequence: 2,
    revision: 1,
    observedAt: 2,
    body: { kind: 'status', text: 'Working', turnLifecycle: { turnId: 'turn-1', state: 'running' } }
  }
]

/** One indexed session over a journal that reads back fixed items; the projection is real. */
const statusFeed = () =>
  new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([
      [
        STATUS_SESSION,
        {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the status feed uses these held rows and provenance reads; the item lookup is checked against the real journal contract.
          journal: {
            cursor: () => ({ epoch: 'epoch-status', sequence: 2 }),
            lastActivityAt: () => 2,
            context: { floor: () => null },
            stopMarks: { latest: () => null, revision: () => 0 },
            snapshot: () => ({ items: STATUS_ITEMS, submissions: [] }),
            item: ((itemId) =>
              STATUS_ITEMS.find((item) => item.itemId === itemId) ??
              null) satisfies AgentSessionJournal['item'],
            itemFence: () => undefined,
            runningTurn: () => null
          } as unknown as AgentSessionJournal,
          params: {
            location: {
              executionHostId: 'local',
              wslDistro: null,
              workspaceId: 'workspace-1',
              workspaceKind: 'git-worktree' as const
            },
            provider: 'codex' as const
          }
        }
      ]
    ]),
    getConversation: () => null,
    now: () => 1_000
  })

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
    publishStructuredAgentSessionTab: vi.fn()
  })
  const runtime = {
    getRuntimeId: () => 'runtime-1',
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
  client?: {
    clientId?: string
    clientKind?: 'mobile' | 'runtime'
    clientCapabilities?: readonly string[]
    signal?: AbortSignal
  },
  runtimeOverrides: Record<string, unknown> = {},
  methods?: readonly RpcAnyMethodDeclaration[]
): Promise<RpcResponse> {
  const replies: RpcResponse[] = []
  await dispatcher(runtimeOverrides, methods).dispatchStreaming(
    request(method, params),
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    client
  )
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
  client: Parameters<typeof call>[2]
): Promise<RpcResponse[]> {
  const replies: RpcResponse[] = []
  await dispatcher().dispatchStreaming(
    request(method, params),
    (raw) => replies.push(JSON.parse(raw) as RpcResponse),
    client
  )
  return replies
}

export {
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
