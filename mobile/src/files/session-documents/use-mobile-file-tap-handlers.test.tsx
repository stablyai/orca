import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'

const push = vi.hoisted(() => vi.fn())
vi.mock('../../navigation/workspace-execution-host', () => ({
  useWorkspaceExecutionHost: () => undefined
}))
vi.mock('../../navigation/workspace-route-handoff', () => ({
  useWorkspaceRouteHandoff: () => ({ push })
}))
vi.mock('../../platform/haptics', () => ({ triggerSelection: () => {} }))

import { useMobileFileTapHandlers } from './use-mobile-file-tap-handlers'

type Client = {
  getGeneration: () => number
  sendRequest: () => Promise<RpcResponse>
}

const SIBLING_ROOT: RpcResponse = {
  id: 'rpc',
  ok: true,
  result: {
    worktree: 'wt-2',
    relativePath: '',
    absolutePath: '/workspaces/wt-2',
    exists: true,
    isDirectory: true
  },
  _meta: { runtimeId: 'runtime-1' }
}

function mountChat() {
  let generation = 1
  let reply: (response: RpcResponse) => void = () => {}
  const createClient = (): Client => ({
    getGeneration: () => generation,
    sendRequest: () =>
      new Promise((resolve) => {
        reply = resolve
      })
  })
  const reportChatTapFailure = vi.fn()
  let tap: (pathText: string) => void = () => {}
  const stable = {
    nativeChatSessionId: 'session-1',
    activeHandleRef: { current: null },
    terminalCwdRef: { current: new Map<string, string>() },
    openBrowser: () => {},
    fetchSessionTabs: async () => {},
    getSessionTabs: () => [],
    getActiveSessionTabId: () => 'chat-tab',
    getActiveSessionTabType: () => 'agent-session',
    switchSessionTab: () => {},
    scheduleDelayedAction: () => {},
    reportChatTapFailure,
    // Held constant so only the authority fence can drop the reply.
    getSendCompletionGeneration: () => 1
  }
  function Probe(props: { client: Client; hostId: string }) {
    tap = useMobileFileTapHandlers({
      ...stable,
      ...props,
      worktreeId: 'wt-1'
    }).handleNativeChatFileTap
    return null
  }
  const first = createClient()
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(Probe, { client: first, hostId: 'host-a' }))
  })
  return {
    first,
    createClient,
    reportChatTapFailure,
    tap: () => tap('/workspaces/wt-2'),
    render: (client: Client, hostId: string) =>
      act(() => renderer.update(createElement(Probe, { client, hostId }))),
    moveGeneration: () => {
      generation = 2
    },
    reply: async () => {
      await act(async () => {
        reply(SIBLING_ROOT)
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }
}

describe('useMobileFileTapHandlers workspace-root reply', () => {
  beforeEach(() => {
    push.mockClear()
  })

  it('drops the reply after the host changes away and back', async () => {
    const chat = mountChat()
    chat.tap()
    chat.render(chat.first, 'host-b')
    chat.render(chat.first, 'host-a')
    await chat.reply()

    expect(push).not.toHaveBeenCalled()
    expect(chat.reportChatTapFailure).not.toHaveBeenCalled()
  })
})
