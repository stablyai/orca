import { launchedSelection, type PendingSessionSelection } from './pending-session-selection'
import { createElement } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useMobileNativeChatActiveResolution } from './use-mobile-native-chat-active-resolution'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { useMobileSessionTerminalCreateActions } from './use-mobile-session-terminal-create-actions'
import { SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY } from '../../../src/shared/protocol-version'
import { SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY } from '../../../src/shared/session-tabs-runtime-capabilities'
import type { MobileSessionTab } from './mobile-session-route-types'

type PlacementTab = { id: string; parentTabId?: string }
type PlacementUpdater = (previous: PlacementTab[]) => PlacementTab[]

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn() }
}))
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return { useFocusEffect: (callback: () => () => void) => useEffect(callback, [callback]) }
})

vi.mock('../platform/haptics', () => ({
  triggerSuccess: vi.fn(),
  triggerError: vi.fn()
}))

function noPendingSelection(): { current: PendingSessionSelection | null } {
  return { current: null }
}

function noCreateLock(): { current: string | null } {
  return { current: null }
}

function clientReturning(...responses: unknown[]): RpcClient {
  let responseIndex = 0
  return {
    sendRequest: vi.fn(async () => responses[responseIndex++])
  } as unknown as RpcClient
}

function terminalCreateResponse(): RpcResponse {
  return {
    id: 'created-terminal',
    ok: true,
    result: {
      tab: {
        type: 'terminal',
        id: 'terminal-tab-1',
        title: 'Codex',
        terminal: 'terminal-1',
        isActive: true
      }
    }
  }
}

function createScope(client: RpcClient) {
  const sessionTabs: MobileSessionTab[] = []
  return {
    nativeChatController: { setTabView: vi.fn() },
    hostId: 'host-1',
    worktreeId: 'workspace-1',
    client,
    hostCapabilities: [],
    connState: 'connected',
    setTerminals: vi.fn(),
    terminalsRef: { current: [] },
    setSessionTabs: vi.fn<(updater: PlacementUpdater) => void>(),
    sessionTabsRef: { current: sessionTabs },
    defaultTerminalHandlesToLiveInput: vi.fn(),
    setActiveHandle: vi.fn(),
    activeSessionTabId: 'existing-tab',
    activeSessionTabIdRef: { current: 'existing-tab' },
    setActiveSessionTabId: vi.fn(),
    setCreating: vi.fn(),
    creatingTerminalRef: noCreateLock(),
    creatingBrowser: false,
    creatingMarkdown: false,
    setCreateError: vi.fn(),
    deviceTokenRef: { current: null },
    initializedHandlesRef: { current: new Set<string>() },
    activeHandleRef: { current: 'existing-terminal' },
    activeSessionTabTypeRef: { current: 'terminal' },
    pendingSelectionRef: noPendingSelection(),
    scheduleDelayedAction: vi.fn(),
    showToast: vi.fn(),
    unsubscribeTerminal: vi.fn(),
    subscribeToTerminal: vi.fn(),
    fetchSessionTabs: vi.fn(async () => {})
  }
}

describe('mobile + Codex tab creation routing', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(() => renderer?.unmount())

  it('uses the structured agent-session path for a bare Codex launch', async () => {
    const client = clientReturning(
      { ok: true, result: { supported: true } },
      {
        ok: true,
        result: {
          ok: true,
          value: { sessionId: 'codex_session_1' }
        }
      }
    )
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal('codex')
    })

    expect(client.sendRequest).toHaveBeenNthCalledWith(1, 'agentSession.createSupport', {
      worktree: 'id:workspace-1',
      agent: 'codex'
    })
    expect(client.sendRequest).toHaveBeenNthCalledWith(
      2,
      'agentSession.create',
      expect.objectContaining({ worktree: 'id:workspace-1', agent: 'codex' }),
      expect.anything()
    )
    expect(client.sendRequest).not.toHaveBeenCalledWith(
      'session.tabs.createTerminal',
      expect.anything()
    )
    // The chat's tab is found by its session in the next snapshot, never by a predicted id.
    expect(scope.pendingSelectionRef.current).toEqual(
      launchedSelection(expect.any(String), { sessionId: 'codex_session_1' })
    )
    expect(scope.setActiveSessionTabId).not.toHaveBeenCalled()
    // The open terminal stays live until the chat's tab lands, rather than blanking beside it.
    expect(scope.setActiveHandle).not.toHaveBeenCalled()
    expect(scope.unsubscribeTerminal).not.toHaveBeenCalled()
    expect(scope.activeSessionTabTypeRef.current).toBe('terminal')
    expect(scope.fetchSessionTabs).toHaveBeenCalledTimes(1)
    expect(scope.scheduleDelayedAction).not.toHaveBeenCalled()
  })

  it('keeps the legacy terminal path when structured support is disabled', async () => {
    const client = clientReturning(
      { ok: false, error: { code: 'structured_agent_session_unsupported', message: 'off' } },
      terminalCreateResponse()
    )
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal('codex')
    })

    expect(client.sendRequest).toHaveBeenNthCalledWith(
      2,
      'session.tabs.createTerminal',
      expect.objectContaining({ worktree: 'id:workspace-1', agent: 'codex' })
    )
    expect(scope.setActiveSessionTabId).toHaveBeenCalledWith('terminal-tab-1')
    expect(scope.nativeChatController.setTabView).not.toHaveBeenCalled()
  })

  it('falls back to a terminal when structured creation is definitively refused', async () => {
    const client = clientReturning(
      { ok: true, result: { supported: true } },
      {
        ok: true,
        result: {
          ok: false,
          refusal: {
            code: 'structured_agent_session_unsupported',
            message: 'provider unavailable'
          }
        }
      },
      terminalCreateResponse()
    )
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal('codex')
    })

    expect(client.sendRequest).toHaveBeenNthCalledWith(
      3,
      'session.tabs.createTerminal',
      expect.objectContaining({ worktree: 'id:workspace-1', agent: 'codex' })
    )
    expect(scope.setActiveSessionTabId).toHaveBeenCalledWith('terminal-tab-1')
  })

  it('keeps prompted Codex launches on the legacy terminal path', async () => {
    const client = clientReturning(terminalCreateResponse(), {
      ok: true,
      result: { send: { accepted: true } }
    })
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal('codex', { initialPrompt: 'Inspect this diff' })
    })

    expect(client.sendRequest).toHaveBeenCalledWith(
      'session.tabs.createTerminal',
      expect.objectContaining({ agent: 'codex' })
    )
    expect(client.sendRequest).not.toHaveBeenCalledWith(
      'agentSession.createSupport',
      expect.anything()
    )
  })

  it('does not create a legacy sibling after an unknown structured outcome', async () => {
    const client = clientReturning({ ok: true, result: { supported: true } })
    const sendRequest = client.sendRequest as unknown as ReturnType<typeof vi.fn>
    sendRequest.mockImplementationOnce(async () => ({
      ok: true,
      result: { supported: true }
    }))
    sendRequest.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('response lost')))
    sendRequest.mockRejectedValueOnce(markRpcDeliveryUnknown(new Error('still unknown')))
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal('codex')
    })

    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'agentSession.createSupport',
      'agentSession.create',
      'agentSession.create'
    ])
    expect(scope.setCreateError).toHaveBeenCalledWith('still unknown')
    expect(scope.showToast).toHaveBeenCalledWith('still unknown', 1800)
  })

  it.each(['agent_session_operation_unknown', 'runtime_error', 'future_unknown_code'])(
    'does not create a legacy sibling after a top-level %s response',
    async (code) => {
      const client = clientReturning(
        { ok: true, result: { supported: true } },
        { ok: false, error: { code, message: 'create outcome ambiguous' } }
      )
      const scope = createScope(client)
      let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
      function Harness() {
        actions = useMobileSessionTerminalCreateActions(scope as never)
        return null
      }
      await act(async () => {
        renderer = create(createElement(Harness))
      })
      await act(async () => {
        await actions?.handleCreateTerminal('codex')
      })

      const sendRequest = client.sendRequest as unknown as ReturnType<typeof vi.fn>
      expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
        'agentSession.createSupport',
        'agentSession.create'
      ])
      expect(scope.setCreateError).toHaveBeenCalledWith('create outcome ambiguous')
      expect(scope.showToast).toHaveBeenCalledWith('create outcome ambiguous', 1800)
    }
  )
  // Why: pty exhaustion, a disabled agent and an unresolved worktree owner all arrived as the
  // same 'Failed to create terminal', leaving the empty session with nothing to act on.
  it('surfaces the host reason instead of a generic terminal-create error', async () => {
    const client = clientReturning({
      ok: false,
      error: {
        code: 'runtime_error',
        message: 'Your system cannot allocate any more pty devices.'
      }
    })
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal()
    })

    expect(scope.setCreateError).toHaveBeenCalledWith(
      'Your system cannot allocate any more pty devices.'
    )
  })

  it('falls back to the generic message when the host gives no reason', async () => {
    const client = clientReturning({ ok: false, error: { code: 'runtime_error', message: '' } })
    const scope = createScope(client)
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal()
    })

    expect(scope.setCreateError).toHaveBeenCalledWith('Failed to create terminal')
  })
})

describe('phone chat CLI fork creation owner', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(() => renderer?.unmount())

  it('lands the CLI fork in terminal under a chat default, retaining later user choices', async () => {
    const stored = new Map([['orca:defaultSessionView', 'chat']])
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => stored.get(key) ?? null)
    vi.mocked(AsyncStorage.setItem).mockImplementation(async (key, value) => {
      stored.set(key, value)
    })
    const scope = createScope(clientReturning(terminalCreateResponse()))
    scope.hostCapabilities = [
      SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY,
      SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY
    ]
    scope.sessionTabsRef.current = [
      {
        type: 'agent-session',
        id: 'chat-tab',
        title: 'Chat',
        sessionId: 'chat-1',
        agent: 'claude',
        isActive: true
      }
    ]
    scope.setActiveSessionTabId.mockImplementation((id: string) => {
      scope.activeSessionTabId = id
    })
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    let resolution: ReturnType<typeof useMobileNativeChatActiveResolution> | undefined
    function Harness() {
      resolution = useMobileNativeChatActiveResolution({
        ...scope,
        activeSessionTab: { type: 'terminal', launchAgent: 'claude' },
        nativeChatTranscriptIsLocalReadable: true
      })
      scope.nativeChatController.setTabView.mockImplementation(resolution.setTabView)
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(resolution?.showNativeChat).toBe(true)
    await act(async () => {
      await actions?.handleCreateTerminal(undefined, {
        sourceChatFork: { sessionId: 'chat-1', agent: 'claude' }
      })
    })
    expect(scope.setActiveSessionTabId).toHaveBeenCalledWith('terminal-tab-1')
    expect(scope.setSessionTabs).not.toHaveBeenCalled()
    expect(resolution?.showNativeChat).toBe(false)
    await act(async () => {
      renderer?.unmount()
      renderer = create(createElement(Harness))
    })
    expect(resolution?.showNativeChat).toBe(false)
    await act(async () => {
      resolution?.toggleTabChatView('terminal-tab-1')
    })
    expect(resolution?.showNativeChat).toBe(true)
    expect(resolution?.isTabChatView('ordinary-tab')).toBe(true)
  })

  it('reports the strict saved-conversation refusal without opening a terminal or fallback', async () => {
    const scope = createScope(
      clientReturning({
        ok: false,
        error: { code: 'chat_fork_source_unavailable', message: 'chat_fork_source_unavailable' }
      })
    )
    scope.hostCapabilities = [SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY]
    scope.sessionTabsRef.current = [
      {
        type: 'agent-session',
        id: 'chat-tab',
        title: 'Chat',
        sessionId: 'chat-1',
        agent: 'claude',
        isActive: true
      }
    ]
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      expect(
        await actions?.handleCreateTerminal(undefined, {
          sourceChatFork: { sessionId: 'chat-1', agent: 'claude' }
        })
      ).toBe('reported-failure')
    })
    expect(scope.client.sendRequest).toHaveBeenCalledTimes(1)
    expect(scope.client.sendRequest).toHaveBeenCalledWith(
      'session.tabs.createTerminal',
      expect.objectContaining({
        sourceChatFork: { sessionId: 'chat-1' }
      }),
      { timeoutMs: 120_000 }
    )
    expect(scope.setActiveSessionTabId).not.toHaveBeenCalled()
    expect(scope.setActiveHandle).not.toHaveBeenCalled()
    expect(scope.setSessionTabs).not.toHaveBeenCalled()
    expect(scope.nativeChatController.setTabView).not.toHaveBeenCalled()
    expect(scope.setCreateError).toHaveBeenCalledWith(
      "Could not open Claude in a new CLI. Check that the chat has a saved conversation and review the agent's command and settings on the host, then try again."
    )
  })

  it('reports a busy create before sending the chat intent', async () => {
    const scope = createScope(clientReturning())
    scope.hostCapabilities = [SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY]
    scope.sessionTabsRef.current = [
      {
        type: 'agent-session',
        id: 'chat-tab',
        title: 'Chat',
        sessionId: 'chat-1',
        agent: 'claude',
        isActive: true
      }
    ]
    scope.creatingTerminalRef.current = 'other-create'
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    let outcome: string | undefined
    await act(async () => {
      outcome = await actions?.handleCreateTerminal(undefined, {
        sourceChatFork: { sessionId: 'chat-1', agent: 'claude' }
      })
    })
    expect(outcome).toBe('busy')
    expect(scope.nativeChatController.setTabView).not.toHaveBeenCalled()
    expect(scope.client.sendRequest).not.toHaveBeenCalled()
    expect(scope.showToast).toHaveBeenCalledWith(expect.stringContaining('Another terminal'), 3000)
  })

  it('does not apply an old route reply after navigating to another workspace', async () => {
    let reply: (value: RpcResponse) => void = () => {}
    const client = clientReturning()
    vi.mocked(client.sendRequest).mockImplementation(
      () =>
        new Promise<RpcResponse>((resolve) => {
          reply = resolve
        })
    )
    const scope = createScope(client)
    scope.hostCapabilities = [SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY]
    scope.sessionTabsRef.current = [
      {
        type: 'agent-session',
        id: 'chat-tab',
        title: 'Chat',
        sessionId: 'chat-1',
        agent: 'claude',
        isActive: true
      }
    ]
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    let pending: Promise<unknown> | undefined
    await act(async () => {
      pending = actions?.handleCreateTerminal(undefined, {
        sourceChatFork: { sessionId: 'chat-1', agent: 'claude' }
      })
    })
    expect(client.sendRequest).toHaveBeenCalledWith(
      'session.tabs.createTerminal',
      expect.objectContaining({ sourceChatFork: { sessionId: 'chat-1' } }),
      { timeoutMs: 120_000 }
    )
    scope.worktreeId = 'workspace-2'
    scope.sessionTabsRef.current = []
    await act(async () => {
      renderer?.update(createElement(Harness))
    })
    await act(async () => {
      reply(terminalCreateResponse())
      await pending
    })
    expect(scope.nativeChatController.setTabView).not.toHaveBeenCalled()
    expect(scope.unsubscribeTerminal).not.toHaveBeenCalled()
    expect(scope.setActiveSessionTabId).not.toHaveBeenCalled()
    expect(scope.subscribeToTerminal).not.toHaveBeenCalled()
    expect(scope.creatingTerminalRef.current).toBeNull()
  })
})

describe('optimistic placement of a created tab', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(() => renderer?.unmount())

  async function createTerminal(scope: ReturnType<typeof createScope>) {
    let actions: ReturnType<typeof useMobileSessionTerminalCreateActions> | undefined
    function Harness() {
      actions = useMobileSessionTerminalCreateActions(scope as never)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    await act(async () => {
      await actions?.handleCreateTerminal()
    })
  }

  function tabIdsAfterCreate(
    scope: ReturnType<typeof createScope>,
    prior: PlacementTab[]
  ): string[] {
    const updater = scope.setSessionTabs.mock.calls.at(-1)?.[0]
    if (!updater) {
      throw new Error('Expected a session tab updater')
    }
    return updater(prior).map((tab) => tab.id)
  }

  it('paints the created tab after the anchor it asked the host for, not at the end', async () => {
    const scope = createScope(clientReturning(terminalCreateResponse()))
    scope.hostCapabilities = [SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY]
    await createTerminal(scope)

    expect(scope.setSessionTabs).toHaveBeenCalled()
    // The request anchored on the active tab, so the paint must land in the same slot the host
    // splices into; appending here is what made the tab jump on the next snapshot.
    expect(tabIdsAfterCreate(scope, [{ id: 'existing-tab' }, { id: 'trailing-tab' }])).toEqual([
      'existing-tab',
      'terminal-tab-1',
      'trailing-tab'
    ])
  })

  it('paints after the active split parent, matching headed host placement', async () => {
    const scope = createScope(clientReturning(terminalCreateResponse()))
    scope.hostCapabilities = [SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY]
    scope.activeSessionTabId = 'existing-tab::left'
    await createTerminal(scope)

    expect(
      tabIdsAfterCreate(scope, [
        { id: 'existing-tab::left', parentTabId: 'existing-tab' },
        { id: 'existing-tab::right', parentTabId: 'existing-tab' },
        { id: 'trailing-tab' }
      ])
    ).toEqual(['existing-tab::left', 'existing-tab::right', 'terminal-tab-1', 'trailing-tab'])
  })

  it('waits for an older host snapshot instead of guessing its placement', async () => {
    const scope = createScope(clientReturning(terminalCreateResponse()))
    scope.activeSessionTabId = 'existing-tab::left'
    await createTerminal(scope)

    expect(scope.setSessionTabs).not.toHaveBeenCalled()
    expect(scope.pendingSelectionRef.current).toEqual({
      kind: 'terminal',
      handle: 'terminal-1',
      tabId: 'terminal-tab-1'
    })
    expect(scope.subscribeToTerminal).toHaveBeenCalledWith('terminal-1')
  })

  it('sends the same anchor it paints with', async () => {
    const scope = createScope(clientReturning(terminalCreateResponse()))
    scope.hostCapabilities = [SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY]
    await createTerminal(scope)

    expect(scope.client.sendRequest).toHaveBeenCalledWith(
      'session.tabs.createTerminal',
      expect.objectContaining({ afterTabId: 'existing-tab' })
    )
  })

  it('appends when the anchor is not in the client list, matching the host fallback', async () => {
    const scope = createScope(clientReturning(terminalCreateResponse()))
    scope.hostCapabilities = [SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY]
    await createTerminal(scope)

    expect(tabIdsAfterCreate(scope, [{ id: 'unrelated-tab' }])).toEqual([
      'unrelated-tab',
      'terminal-tab-1'
    ])
  })

  it('leaves the list alone when the host snapshot already placed the tab', async () => {
    const scope = createScope(clientReturning(terminalCreateResponse()))
    scope.hostCapabilities = [SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY]
    await createTerminal(scope)

    const prior = [{ id: 'existing-tab' }, { id: 'terminal-tab-1' }, { id: 'trailing-tab' }]
    expect(tabIdsAfterCreate(scope, prior)).toEqual([
      'existing-tab',
      'terminal-tab-1',
      'trailing-tab'
    ])
  })
})
