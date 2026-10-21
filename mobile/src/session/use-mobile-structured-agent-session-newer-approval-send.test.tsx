// A host's queue waits on any pending prompt. While every pending prompt is an approval this build
// cannot answer, nothing here can settle it, so a send goes out without `delivery` and starts a
// turn, whose card cancel then works.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import {
  CAPABLE,
  SESSION_ID,
  fieldsOf,
  mutationOk,
  ok,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'

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

function approval(subject: Record<string, unknown>): AgentJournalRenderItem {
  return JSON.parse(
    JSON.stringify({
      itemId: `approval-${String(subject.kind)}`,
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'approval',
        title: 'Review',
        detail: null,
        subject,
        options: [{ id: 'allow', label: 'Approve' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    })
  )
}

async function sentDelivery(items: AgentJournalRenderItem[]): Promise<unknown> {
  act(() => {
    renderer = create(createElement(Harness))
  })
  await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
  const event = snapshotEvent()
  if (event.type === 'snapshot') {
    event.page.items = items
  }
  act(() => listener?.(event))
  await act(async () => {
    await hook!.sendWithOutcome('carry on')
  })
  const send = sendRequest.mock.calls.find(([method]) => method === 'agentSession.send')
  return fieldsOf(send?.[1]).delivery
}

beforeEach(() => {
  vi.clearAllMocks()

  sendRequest.mockImplementation(async (method) =>
    method === 'agentSession.send'
      ? mutationOk({ clientMessageId: 'client-1' })
      : method === 'agentSession.options'
        ? ok({ models: [], current: {} })
        : ok({})
  )
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  hook = null
  listener = null
})

it('sends without queueing while every pending prompt is one this build cannot answer', async () => {
  expect(await sentDelivery([approval({ kind: 'diff', path: 'a.ts' })])).toBeUndefined()
})

it('still queues beside a prompt this build can answer', async () => {
  expect(
    await sentDelivery([
      approval({ kind: 'diff', path: 'a.ts' }),
      approval({ kind: 'plan', text: 'do it' })
    ])
  ).toBe('queue-if-active')
})

const RUNNING_TURN: AgentJournalRenderItem = {
  itemId: 'turn-1',
  revision: 1,
  sequence: 2,
  observedAt: 1,
  body: { kind: 'turn', turnId: 'provider-turn', state: 'running' }
}

/** What the composer says a send does while this phone's Stop is still in flight. */
async function afterStop(items: AgentJournalRenderItem[]): Promise<unknown> {
  // The Stop's request stays in flight, so the phone keeps reading Stopping.
  sendRequest.mockImplementation(async (method) =>
    method === 'agentSession.cancel'
      ? new Promise(() => undefined)
      : method === 'agentSession.options'
        ? ok({ models: [], current: {} })
        : ok({})
  )
  act(() => {
    renderer = create(createElement(Harness))
  })
  await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
  const event = snapshotEvent()
  if (event.type === 'snapshot') {
    event.page.items = [RUNNING_TURN, ...items]
  }
  act(() => listener?.(event))
  act(() => hook?.cancel())
  expect(hook?.turnIndicator.stopping).toBe(true)
  return hook?.turnIndicator.afterStop
}

it('says a send after a Stop is sent, not queued, while every pending prompt is one this build cannot answer', async () => {
  expect(await afterStop([approval({ kind: 'diff', path: 'a.ts' })])).toBe('send')
})

it('says a send after a Stop is queued beside a prompt this build can answer', async () => {
  expect(await afterStop([approval({ kind: 'plan', text: 'do it' })])).toBe('queue')
})
