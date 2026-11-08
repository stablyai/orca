import { createElement } from 'react'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { createWithQueryClient } from '../../../test-support/query-client-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_SESSION_PHONE_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY } from '../../../../../src/shared/agent-session/agent-session-continue-interrupted-capability'
import type { RpcClient } from '../../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../../transport/rpc/rpc-wire-types'
import { structuredAgentSessionHostSupport } from '../../mobile-structured-agent-session-host-support'
import {
  snapshotEvent,
  SESSION_ID
} from './use-mobile-structured-agent-session-queued.test-fixture'
import { useMobileStructuredAgentSession } from '../../use-mobile-structured-agent-session'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() }
}))

const CUT: AgentJournalRenderItem[] = [
  {
    itemId: 'turn-cut',
    revision: 2,
    sequence: 1,
    observedAt: 1,
    body: { kind: 'turn', turnId: 'cut', state: 'interrupted', startedAt: 1, completedAt: 5 }
  },
  {
    itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: 'stale-session:s:death-1-5' }),
    revision: 1,
    sequence: 2,
    observedAt: 6,
    turnScope: { kind: 'turn', turnItemId: 'turn-cut' },
    body: { kind: 'status', text: 'Codex stopped.', tone: 'error', orcaStop: { cause: 'crash' } }
  }
]
const CONTINUED_ELSEWHERE: AgentJournalRenderItem[] = [
  ...CUT,
  {
    itemId: 'user-after',
    revision: 0,
    sequence: 3,
    observedAt: 7,
    turnScope: { kind: 'thread' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Continue' }] }
  }
]

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

it('continues an Orca-stopped turn, shows a refusal, and drops it once another client continues', async () => {
  let listener: ((value: unknown) => void) | null = null
  const sendRequest = vi.fn(async (method: string): Promise<RpcResponse> => ({
    id: 'response-1',
    ok: true,
    result: method === 'agentSession.continueInterrupted' ? { outcome: 'refused' } : {},
    _meta: { runtimeId: 'runtime-1' }
  }))
  const client: Pick<RpcClient, 'sendRequest' | 'subscribe' | 'getState' | 'onStateChange'> = {
    getState: () => 'connected',
    onStateChange: () => () => {},
    sendRequest,
    subscribe: vi.fn((method: string, _params: unknown, onData: (value: unknown) => void) => {
      if (method === 'agentSession.subscribe') {
        listener = onData
      }
      return () => {}
    })
  }
  const rendered: { hook: ReturnType<typeof useMobileStructuredAgentSession> | null } = {
    hook: null
  }
  function Harness(): null {
    rendered.hook = useMobileStructuredAgentSession({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook's request, subscription and connection members are provided.
      client: client as RpcClient,
      pairedHostClient: null,
      sessionId: SESSION_ID,
      enabled: true,
      connected: true,
      hostSupport: structuredAgentSessionHostSupport([
        AGENT_SESSION_PHONE_CONTINUE_INTERRUPTED_RUNTIME_CAPABILITY
      ]),
      agent: 'codex',
      onSendError: vi.fn()
    })
    return null
  }
  act(() => {
    renderer = createWithQueryClient(createElement(Harness))
  })
  await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
  act(() => listener?.(snapshotEvent({ items: CUT })))

  await vi.waitFor(() =>
    expect(rendered.hook?.interruptedContinue.offeredTurnItemId).toBe('turn-cut')
  )
  // The row the notice draws must carry the same cut, or no Continue shows on it.
  expect(rendered.hook?.session.messages.at(-1)?.blocks[0]).toMatchObject({
    orcaStop: { cause: 'crash', turnItemId: 'turn-cut' }
  })

  act(() => rendered.hook?.interruptedContinue.continueNow())
  expect(sendRequest).toHaveBeenCalledWith(
    'agentSession.continueInterrupted',
    { sessionId: SESSION_ID, turnItemId: 'turn-cut' },
    expect.anything()
  )
  await vi.waitFor(() => expect(rendered.hook?.interruptedContinue.failed).toBe(true))
  expect(rendered.hook?.interruptedContinue.offeredTurnItemId).toBe('turn-cut')

  act(() => listener?.(snapshotEvent({ items: CONTINUED_ELSEWHERE })))
  await vi.waitFor(() => expect(rendered.hook?.interruptedContinue.failed).toBe(false))
  expect(rendered.hook?.interruptedContinue.offeredTurnItemId).toBeNull()
})
