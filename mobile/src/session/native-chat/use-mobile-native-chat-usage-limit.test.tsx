import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionFailureWords } from '../../../../src/shared/agent-session/failures/agent-session-failure-words'
import { agentJournalItemKey } from '../../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { RpcClient } from '../../transport/rpc-client'
import { stubRpcClient } from '../../transport/rpc-client-test-stub'
import { structuredAgentSessionHostSupport } from '../mobile-structured-agent-session-host-support'
import { useMobileNativeChatUsageLimit } from './use-mobile-native-chat-usage-limit'

const TURN = agentJournalItemKey({ provider: 'claude', sessionId: 's', uuid: 'cut' })
const RESETS_AT = 1_800_000_000_000

const limitedChat: AgentJournalRenderItem[] = [
  {
    itemId: TURN,
    revision: 2,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'turn',
      turnId: 'cut',
      state: 'completed',
      outcome: 'failure',
      startedAt: 1,
      completedAt: 5
    }
  },
  {
    itemId: 'limit-row',
    revision: 1,
    sequence: 2,
    observedAt: 6,
    turnScope: { kind: 'turn', turnItemId: TURN },
    body: {
      kind: 'status',
      ...agentSessionFailureWords(
        { kind: 'usageLimitReached', usageLimit: { window: 'session', resetsAt: RESETS_AT } },
        { surface: 'row' }
      )
    }
  }
]

let latest: ReturnType<typeof useMobileNativeChatUsageLimit> | undefined
let renderer: ReactTestRenderer | undefined
afterEach(() => act(() => renderer?.unmount()))

const FEED = 'agent-session.status-feed.v1'
const AUTO_CONTINUE = 'agent-session.usage-limit-auto-continue.v1'
const PHONE_CANCEL = 'agent-session.usage-limit-auto-continue.phone-cancel.v1'
const CONTINUATION = 'agent-session.send-usage-limit-continuation.v1'

async function mount(capabilities: string[]) {
  const host = vi.fn<RpcClient['sendRequest']>(async (method) => ({
    ok: true as const,
    result:
      method === 'agentSession.options' ? { models: [], canSwitchAccount: true } : { ok: true },
    id: 'r',
    _meta: { runtimeId: 'host' }
  }))
  const client = stubRpcClient({
    sendRequest: host,
    subscribe: (_method, _params, onData) => {
      onData({
        type: 'snapshot',
        sessions: [
          {
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            agent: 'claude',
            status: 'idle',
            updatedAt: 1,
            usageLimitContinue: { turnItemId: TURN, resetsAt: RESETS_AT, state: 'scheduled' }
          }
        ]
      })
      return () => {}
    }
  })
  const send = vi.fn(async () => 'accepted' as const)
  function Probe() {
    latest = useMobileNativeChatUsageLimit(
      {
        client,
        sessionId: 'session-1',
        enabled: true,
        connected: true,
        hostSupport: structuredAgentSessionHostSupport(capabilities)
      },
      { items: limitedChat, submissions: [] },
      { busy: false, send }
    )
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe))
  })
  return { host, send }
}

it("acts on the latest cut with the host's answers: cancel, continue and account move", async () => {
  const { host, send } = await mount([FEED, AUTO_CONTINUE, PHONE_CANCEL, CONTINUATION])

  expect(latest).toMatchObject({
    turnItemId: TURN,
    autoContinue: 'scheduled',
    canSwitchAccount: true
  })
  await act(async () => latest?.cancel?.())
  expect(host).toHaveBeenCalledWith(
    'agentSession.cancelUsageLimitContinue',
    { sessionId: 'session-1', turnItemId: TURN, resetsAt: RESETS_AT },
    expect.anything()
  )
  act(() => latest?.continueNow())
  expect(send).toHaveBeenCalledWith(
    'Continue where you left off.',
    [],
    undefined,
    undefined,
    undefined,
    { usageLimitContinuationOfTurnItemId: TURN }
  )
})

it("offers no Don't continue on a host that refuses it from a phone", async () => {
  await mount([FEED, AUTO_CONTINUE])

  expect(latest).toMatchObject({ autoContinue: 'scheduled', cancel: null })
})
