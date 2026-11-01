import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionState } from '../transport/types'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import { useMobileWorkspaceSetupHold } from './use-mobile-workspace-setup-hold'
import { useMobileStructuredNativeChatSendBridge } from './use-mobile-structured-native-chat-send-bridge'

let view: ReactTestRenderer | undefined
let availability: ReturnType<typeof useMobileWorkspaceSetupHold>
let send: ReturnType<typeof useMobileStructuredNativeChatSendBridge>['send']
const capture = vi.fn()
const clear = vi.fn()
const dispatch = vi.fn()
const error = vi.fn()
const frames = new Map<string, (frame: unknown) => void>()
const connections = new Map<string, (state: ConnectionState) => void>()
const clients = new Map(
  ['host', 'other-host'].map((host) => [
    host,
    stubRpcClient({
      subscribe: (_method, _params, listener) => {
        frames.set(host, listener)
        return () => {}
      },
      onStateChange: (listener) => {
        connections.set(host, listener)
        return () => {}
      }
    })
  ])
)
function project(host: string, held: boolean) {
  frames.get(host)?.({
    type: 'snapshot',
    sessions: [],
    setupHeldWorkspaceIds: held ? ['workspace'] : []
  })
}
function Fixture({ host = 'host', workspace = 'workspace', connected = true }) {
  availability = useMobileWorkspaceSetupHold(host, workspace, connected, clients.get(host) ?? null)
  send = useMobileStructuredNativeChatSendBridge({
    agent: 'claude',
    readSetupAgentStartHeld: availability.readSetupAgentStartHeld,
    captureSendOrigin: capture,
    clearDraftForSend: clear,
    restoreRejectedDraft: vi.fn(),
    onSendError: error,
    sendStructured: dispatch
  }).send
  return null
}
afterEach(() => {
  act(() => view?.unmount())
  view = undefined
  vi.clearAllMocks()
})
it('revokes on reconnect/route replacement and fences retained direct Send before any draft custody mutation', async () => {
  act(() => {
    view = create(createElement(Fixture))
  })
  const retainedSend = send
  act(() => project('host', true))
  expect(availability.setupAgentStartHeld).toBe(true)
  await expect(retainedSend('retained draft')).resolves.toBe(false)
  expect(capture).not.toHaveBeenCalled()
  expect(clear).not.toHaveBeenCalled()
  expect(dispatch).not.toHaveBeenCalled()
  expect(error).not.toHaveBeenCalled()
  act(() => {
    connections.get('host')?.('reconnecting')
    view!.update(createElement(Fixture, { connected: false }))
  })
  expect(availability.setupAgentStartHeld).toBe(false)
  act(() => view!.update(createElement(Fixture)))
  expect(availability.setupAgentStartHeld).toBe(false)
  act(() => project('host', false))
  expect(availability.setupAgentStartHeld).toBe(false)
  act(() => project('host', true))
  await expect(retainedSend('retained draft')).resolves.toBe(false)
  act(() => view!.update(createElement(Fixture, { host: 'other-host' })))
  expect(availability.setupAgentStartHeld).toBe(false)
  act(() => project('other-host', true))
  await expect(retainedSend('retained draft')).resolves.toBe(false)
  expect(clear).not.toHaveBeenCalled()
})
