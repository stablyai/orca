// A replacement process's options read can fail; the chat's known choices still reach that process.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import {
  CAPABLE,
  SESSION_ID,
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
    if (_method === 'agentSession.subscribe') {
      listener = onData
    }
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

const OPTIONS = {
  models: ['gpt-fast', 'gpt-slow'].map((id, index) => ({
    id,
    label: id,
    isDefault: index === 0,
    efforts: [
      { value: 'low', label: 'Low' },
      { value: 'high', label: 'High' }
    ]
  })),
  current: { model: 'gpt-fast', effort: 'low', permissionMode: 'ask' }
}

// This host predates the model listing, so the options answer is the chat's only model list.
async function hostAnswer(method: string) {
  return method === 'agentSession.modelCatalog'
    ? {
        id: 'request-1',
        ok: false as const,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'runtime-1' }
      }
    : ok(method === 'agentSession.options' ? OPTIONS : {})
}

function Harness(): null {
  hook = useMobileStructuredAgentSession({
    client,
    sessionId: SESSION_ID,
    sourceIdentity: 'host-a\0workspace-a',
    enabled: true,
    connected: true,
    agent: 'codex',
    hostSupport: { ...CAPABLE, permissionModes: true, permissionOwn: true },
    onSendError: vi.fn()
  })
  return null
}

const optionReads = () =>
  sendRequest.mock.calls.filter(([method]) => method === 'agentSession.options').length
const descriptor = (id: string) => hook!.optionSnapshot.find((entry) => entry.id === id)

beforeEach(() => {
  vi.clearAllMocks()
  sendRequest.mockImplementation(hostAnswer)
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  hook = null
  listener = null
})

it('sends a pick on a restarted process to its new fence while its options reads fail', async () => {
  act(() => {
    renderer = create(createElement(Harness))
  })
  await vi.waitFor(() => expect(listener).toEqual(expect.any(Function)))
  act(() => listener?.(snapshotEvent({ fence: 3 })))
  await vi.waitFor(() => expect(descriptor('permissionMode')).toMatchObject({ settable: true }))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const beforeRestart = optionReads()
  sendRequest.mockImplementation(async (method) => {
    if (method === 'agentSession.options') {
      throw new Error('request timed out')
    }
    return method === 'agentSession.setOption'
      ? ok({
          ok: true,
          replayed: false,
          fence: 4,
          cursor: { epoch: 'epoch-1', sequence: 2 },
          value: { key: 'model', value: 'gpt-slow', options: { model: 'gpt-slow' } }
        })
      : hostAnswer(method)
  })

  act(() => listener?.(snapshotEvent({ fence: 4 })))
  // The replacement process's read and both retries fail; the chat's known choices stay usable.
  await vi.waitFor(() => expect(optionReads()).toBe(beforeRestart + 3), { timeout: 3000 })
  for (const id of ['model', 'effort', 'permissionMode']) {
    expect(descriptor(id), id).toMatchObject({ settable: true })
  }
  await act(async () => {
    expect(await hook!.setStructuredOption('model', 'gpt-slow')).toBe(true)
  })
  expect(sendRequest).toHaveBeenCalledWith(
    'agentSession.setOption',
    expect.objectContaining({
      envelope: expect.objectContaining({ sessionId: SESSION_ID, expectedRuntimeFence: 4 }),
      key: 'model',
      value: 'gpt-slow'
    }),
    expect.any(Object)
  )
  // Only an accepted pick is remembered as the agent's choice.
  expect(sendRequest).toHaveBeenCalledWith('settings.mutateNativeChatSessionOptions', {
    type: 'apply-picks',
    agent: 'codex',
    picks: [{ modelId: 'gpt-slow', optionId: 'model', value: 'gpt-slow' }]
  })
})
