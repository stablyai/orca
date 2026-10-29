// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'
import { useMobileAgentHistoryState } from './use-mobile-agent-history-state'

const connection = vi.hoisted((): { client: RpcClient | null; state: ConnectionState } => ({
  client: null,
  state: 'connected'
}))
vi.mock('../transport/use-workspace-client', () => ({ useWorkspaceClient: () => connection }))
vi.mock('../transport/host-client-hooks', () => ({ useForceReconnect: () => null }))
function fakeClient(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => connection.state,
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

it('refreshes a mounted provider row on current-client association changes with bounded work', async () => {
  let emit = (_frame: unknown): void => {}
  const manualName = 'Budget plan'
  const native = {
    sessionId: 'native',
    workspaceId: 'workspace',
    agent: 'pi',
    latestPrompt: '',
    status: null,
    updatedAt: 1,
    providerSession: { key: 'session_id', id: '/provider' },
    conversationName: manualName
  }
  const row = {
    id: 'provider',
    agent: 'pi',
    sessionId: 'provider',
    title: manualName,
    executionHostId: 'local',
    filePath: '/provider',
    resumeCommand: 'pi --session /provider',
    cwd: null,
    modifiedAt: '',
    previewMessages: [],
    messageCount: 1,
    structuredSession: { sessionId: 'native', workspaceId: 'workspace' }
  }
  let detached = false
  let hold = false
  let finish = (_reply: RpcResponse): void => {}
  const send = vi.fn<RpcClient['sendRequest']>(async (method) => {
    if (method === 'status.get') {
      return { id: 'status', ok: true, result: { capabilities: ['aiVault.v1'] } }
    }
    const reply: RpcResponse = {
      id: 'scan',
      ok: true,
      result: {
        issues: [],
        sessions: [
          detached ? { ...row, title: 'Provider title', structuredSession: undefined } : row
        ]
      }
    }
    return hold
      ? new Promise((resolve) => {
          finish = resolve
        })
      : reply
  })
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _args, listener) => {
    emit = listener
    return () => {}
  })
  let clientGeneration = 0
  connection.client = { ...fakeClient(send), subscribe, getGeneration: () => clientGeneration }
  connection.state = 'connected'
  const worktrees: Worktree[] = []
  let hostId = 'phone-host'
  let current: ReturnType<typeof useMobileAgentHistoryState> | null = null
  function Probe() {
    current = useMobileAgentHistoryState({
      hostId,
      worktreeId: 'workspace',
      worktrees,
      worktreesLoaded: true
    })
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(createElement(Probe)))
  const read = () => {
    if (!current) {
      throw new Error('not mounted')
    }
    return current
  }
  try {
    await act(async () => emit({ type: 'snapshot', sessions: [native] }))
    const baseline = send.mock.calls.length
    for (const n of [10, 100]) {
      await act(async () => {
        for (let i = 0; i < n; i++) {
          emit({ type: 'status', session: { ...native, updatedAt: i, toolName: `${i}` } })
          emit({
            type: 'snapshot',
            sessions: [],
            namingActiveSessionIds: [],
            conversationNames: [{ sessionId: 'native', conversationName: manualName }]
          })
        }
      })
      expect(send).toHaveBeenCalledTimes(baseline)
    }
    hold = true
    let pending: Promise<void> | undefined
    await act(async () => {
      pending = read().onRefresh()
    })
    const { providerSession: _provider, ...cleared } = native
    detached = true
    await act(async () => {
      for (const id of ['/next', '/third']) {
        emit({ type: 'status', session: { ...native, providerSession: { key: 'session_id', id } } })
      }
      emit({ type: 'status', session: cleared })
    })
    expect(read().screenState).toMatchObject({
      kind: 'ready',
      sessions: [{ title: manualName, structuredSession: { sessionId: 'native' } }]
    })
    hold = false
    await act(async () => {
      finish({ id: 'old', ok: true, result: { sessions: [row], issues: [] } })
      await pending
    })
    expect(read().screenState).toMatchObject({
      kind: 'ready',
      sessions: [
        {
          title: 'Provider title',
          structuredSession: undefined,
          executionHostId: 'local',
          filePath: '/provider',
          resumeCommand: 'pi --session /provider'
        }
      ]
    })
    expect(send.mock.calls.slice(baseline).map(([method]) => method)).toEqual([
      'status.get',
      'aiVault.listSessions',
      'status.get',
      'aiVault.listSessions'
    ])
    expect(subscribe).toHaveBeenCalledOnce()
    hold = true
    await act(async () => {
      pending = read().onRefresh()
    })
    const generationReply = finish
    hold = false
    await act(async () => {
      clientGeneration += 1
      root.render(createElement(Probe))
    })
    await act(async () => {
      generationReply({
        id: 'retired-generation',
        ok: true,
        result: { sessions: [row], issues: [] }
      })
      await pending
    })
    expect(read().screenState).toMatchObject({
      kind: 'ready',
      sessions: [
        {
          title: 'Provider title',
          structuredSession: undefined,
          executionHostId: 'local',
          sessionId: 'provider',
          resumeCommand: 'pi --session /provider'
        }
      ]
    })
    expect(subscribe).toHaveBeenCalledOnce()
    send.mockRejectedValueOnce(new Error('connected failure'))
    await act(async () =>
      emit({ type: 'status', session: { ...cleared, providerSession: native.providerSession } })
    )
    expect(read().screenState).toEqual({ kind: 'error', message: 'connected failure' })
    hold = true
    await act(async () => {
      pending = read().onRefresh()
    })
    hold = false
    await act(async () => read().onSelectScope('all'))
    const retiredEmit = emit
    const nextSend = vi.fn<RpcClient['sendRequest']>(async (method) => ({
      id: 'new-host',
      ok: true,
      result:
        method === 'status.get'
          ? { capabilities: ['aiVault.v1'] }
          : {
              sessions: [{ ...row, title: 'Current host', structuredSession: undefined }],
              issues: []
            }
    }))
    connection.client = { ...fakeClient(nextSend), subscribe }
    hostId = 'other-host'
    await act(async () => root.render(createElement(Probe)))
    await act(async () => {
      finish({ id: 'retired', ok: true, result: { sessions: [row], issues: [] } })
      await pending
      retiredEmit({ type: 'status', session: native })
    })
    expect(read().scope).toBe('all')
    expect(read().screenState).toMatchObject({
      kind: 'ready',
      sessions: [{ title: 'Current host', structuredSession: undefined }]
    })
    expect(nextSend).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount())
  }
  const activeSend = vi.mocked(connection.client!.sendRequest)
  const calls = activeSend.mock.calls.length
  await act(async () => emit({ type: 'status', session: native }))
  expect(activeSend).toHaveBeenCalledTimes(calls)
})
