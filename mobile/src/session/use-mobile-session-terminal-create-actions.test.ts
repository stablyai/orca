import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { useMobileSessionTerminalCreateActions } from './use-mobile-session-terminal-create-actions'

vi.mock('../platform/haptics', () => ({
  triggerSuccess: vi.fn(),
  triggerError: vi.fn()
}))

function clientReturning(...responses: unknown[]): RpcClient {
  let responseIndex = 0
  return {
    sendRequest: vi.fn(async () => responses[responseIndex++])
  } as unknown as RpcClient
}

function terminalCreateResponse() {
  return {
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
  return {
    worktreeId: 'workspace-1',
    client,
    connState: 'connected',
    setTerminals: vi.fn(),
    terminalsRef: { current: [] },
    setSessionTabs: vi.fn(),
    defaultTerminalHandlesToLiveInput: vi.fn(),
    setActiveHandle: vi.fn(),
    activeSessionTabId: 'existing-tab',
    activeSessionTabIdRef: { current: 'existing-tab' },
    setActiveSessionTabId: vi.fn(),
    setCreating: vi.fn(),
    creatingTerminalRef: { current: false },
    creatingBrowser: false,
    creatingMarkdown: false,
    setCreateError: vi.fn(),
    deviceTokenRef: { current: null },
    initializedHandlesRef: { current: new Set<string>() },
    activeHandleRef: { current: 'existing-terminal' },
    activeSessionTabTypeRef: { current: 'terminal' },
    pendingActiveSessionTabIdRef: { current: null },
    pendingActiveTerminalHandleRef: { current: null },
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
    expect(scope.setActiveSessionTabId).toHaveBeenCalledWith('agent-session:codex_session_1')
    expect(scope.setActiveHandle).toHaveBeenCalledWith(null)
    expect(scope.unsubscribeTerminal).toHaveBeenCalledWith('existing-terminal')
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
  })

  it('falls back to a terminal when structured creation is refused', async () => {
    const client = clientReturning(
      { ok: true, result: { supported: true } },
      {
        ok: true,
        result: {
          ok: false,
          refusal: { code: 'agent_session_ownership_unknown', message: 'provider unavailable' }
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
})
