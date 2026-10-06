// A refused read of a chat's history: the phone keeps the refusal beside its words, so a failure no
// retry gets past (damage, a newer Orca's chat) shows no composer under it.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { resetMobileStructuredSendOperationJournalForTests } from './mobile-structured-send-operation-journal'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { CAPABLE, SESSION_ID, ok } from './use-mobile-structured-agent-session-queued.test-fixture'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => undefined),
  removeItem: vi.fn(async () => undefined)
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

let renderer: ReactTestRenderer | null = null
let hook: ReturnType<typeof useMobileStructuredAgentSession> | null = null
let listener: ((value: unknown) => void) | null = null
const sendRequest = vi.fn<RpcClient['sendRequest']>()
const client: RpcClient = {
  sendRequest,
  subscribe: vi.fn<RpcClient['subscribe']>((_method, _params, onData) => {
    listener = onData
    return vi.fn()
  }),
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

function Harness(): null {
  hook = useMobileStructuredAgentSession({
    client,
    sessionId: SESSION_ID,
    sourceIdentity: 'host-a\0workspace-a',
    enabled: true,
    connected: true,
    agent: 'claude',
    hostSupport: CAPABLE,
    appendComposerText: () => true,
    onSendError: vi.fn()
  })
  return null
}

/** The stream's error frame for a refused read, as the RPC client hands it over. */
function refusedRead(reason: string) {
  const error = {
    code: 'runtime_error',
    message: 'agent_session_journal_unreadable',
    data: { refusal: { code: 'agent_session_journal_unreadable', details: { reason } } }
  }
  return { type: 'error', message: error.message, error }
}

async function readFailedWith(reason: string) {
  act(() => {
    renderer = create(createElement(Harness))
  })
  await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
  act(() => listener?.(refusedRead(reason)))
  return hook!.session
}

beforeEach(() => {
  vi.clearAllMocks()
  resetMobileStructuredSendOperationJournalForTests()
  sendRequest.mockImplementation(async (method) =>
    method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
  )
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  hook = null
  listener = null
})

it.each([
  ['journalCorrupt', 'Unable to load this chat.'],
  ['journalWrittenByNewerOrca', 'This chat was saved by a newer Orca. Update Orca to open it.']
])('reads %s as a failure no retry gets past, in its words', async (reason, words) => {
  expect(await readFailedWith(reason)).toMatchObject({
    status: 'error',
    error: words,
    readFailedFinally: true
  })
})

it('reads a failure that can clear as one the chat keeps trying past', async () => {
  expect(await readFailedWith('journalUnavailable')).toMatchObject({
    status: 'error',
    readFailedFinally: false
  })
})
