import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../../src/shared/agent-session-wire'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => undefined),
  removeItem: vi.fn(async () => undefined)
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a literal snapshot frame; the hook reads its type, page and fence.
const SNAPSHOT: AgentSessionSubscribeEvent = {
  type: 'snapshot',
  sessionId: 'session-1',
  fence: 3,
  page: {
    sessionId: 'session-1',
    epoch: 'epoch-1',
    direction: 'tail',
    items: [
      {
        itemId: 'msg-1',
        revision: 1,
        sequence: 1,
        observedAt: 10,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'still here' }] }
      }
    ],
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: { epoch: 'epoch-1', sequence: 1 },
      newest: { epoch: 'epoch-1', sequence: 1 },
      nextCursor: { epoch: 'epoch-1', sequence: 2 }
    },
    liveCursor: { epoch: 'epoch-1', sequence: 1 },
    hasOlder: false,
    hasNewer: false
  }
} as AgentSessionSubscribeEvent

let renderer: ReactTestRenderer | null = null
let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  hook = null
})

beforeEach(() => {
  vi.clearAllMocks()
})

it('subscribes when an older host refuses the hold, and shows the transcript (P2-24)', async () => {
  const sendRequest = vi.fn(async (method: string) =>
    method === 'agentSession.hold'
      ? {
          ok: false,
          error: { code: 'agent_session_owner_restart_failed', message: 'Codex could not start.' },
          _meta: { runtimeId: 'runtime-1' }
        }
      : { ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } }
  )
  const subscribe = vi.fn((_method: string, _params: unknown, onData: (value: unknown) => void) => {
    onData(SNAPSHOT)
    return () => undefined
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an RPC client stub with the two members the hook calls.
  const client = { sendRequest, subscribe } as unknown as RpcClient
  function Harness(): null {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook's options, of which this test supplies the ones it reads.
    hook = useMobileStructuredAgentSession({
      client,
      sessionId: 'session-1',
      sourceIdentity: 'host-a\0workspace-a',
      enabled: true,
      connected: true,
      agent: 'codex',
      onSendError: () => undefined
    } as never)
    return null
  }

  act(() => {
    renderer = create(createElement(Harness))
  })

  await vi.waitFor(() =>
    expect(subscribe).toHaveBeenCalledWith(
      'agentSession.subscribe',
      { sessionId: 'session-1' },
      expect.any(Function)
    )
  )
  await vi.waitFor(() => expect(hook?.session.messages.length).toBeGreaterThan(0))
  expect(hook?.session.status).not.toBe('error')
})
